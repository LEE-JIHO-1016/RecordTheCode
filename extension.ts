import * as vscode from 'vscode';
import { CodeTracker } from './database';
import * as cp from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const codeTracker = new CodeTracker();
    let lastDocumentState: { [uri: string]: string } = {};
    let terminalOutput: string[] = [];
    let changeBuffer: { [fileName: string]: any[] } = {};
    let debugEndPoints: number[] = [];
    let totalChanges = 0; // Track the total number of changes

    const terminal = vscode.window.createTerminal({ name: "Code Playback Terminal" });
    terminal.show();

    context.subscriptions.push(vscode.commands.registerCommand('codePlayback', () => {
        const panel = createWebView(context);
        handleMessages(panel, codeTracker, terminalOutput, debugEndPoints);
    }));

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.fileName.match(/_test_record/)) {
            lastDocumentState[doc.uri.toString()] = doc.getText();
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.fileName.match(/_test_record/)) {
            const documentUri = event.document.uri.toString();
            const previousContent = lastDocumentState[documentUri] || "";
            const currentContent = event.document.getText();
            lastDocumentState[documentUri] = currentContent;

            event.contentChanges.forEach(change => {
                let changeType = 'edit';
                let affectedContent = '';
                let indent = 0;

                const lineText = event.document.lineAt(change.range.start.line).text;
                indent = lineText.length - lineText.trimStart().length;

                if (change.text === '' && change.rangeLength > 0) {
                    changeType = 'delete';
                    const startPos = event.document.offsetAt(change.range.start);
                    const endPos = startPos + change.rangeLength;
                    affectedContent = previousContent.substring(startPos, endPos);
                } else {
                    affectedContent = change.text;
                }

                const { line, character } = change.range.start;
                if (!changeBuffer[event.document.fileName]) {
                    changeBuffer[event.document.fileName] = [];
                }

                changeBuffer[event.document.fileName].push({
                    fileName: event.document.fileName,
                    changeType,
                    affectedContent,
                    line,
                    character,
                    indent,
                });
                console.log(`File changed: ${event.document.fileName}, Change type: ${changeType}, Affected Content: '${affectedContent}', Indent: ${indent}`);
                totalChanges++; // Increment the total number of changes
            });
        }
    }));

    vscode.debug.onDidTerminateDebugSession(() => {
        let changeCount = 0;
        for (const [fileName, changes] of Object.entries(changeBuffer)) {
            changeCount += changes.length;
            codeTracker.batchRecordChanges(changes, terminalOutput.join('\n'));

            const filePath = path.resolve(fileName);
            executePythonScript(filePath).then(output => {
                terminalOutput.push(output);
                terminalOutput = terminalOutput.slice(-50); // Maintain only the last 50 logs
                terminal.sendText(output);
            });
        }

        debugEndPoints.push(totalChanges); // Record the total number of changes up to this point
        changeBuffer = {}; // Clear buffer after processing
    });

    context.subscriptions.push({
        dispose: () => {
            codeTracker.deactivate();
            lastDocumentState = {};
            terminal.dispose();
        }
    });
}

async function executePythonScript(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(`python "${filePath}"`, { encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                resolve(stderr);
            } else {
                resolve(stdout);
            }
        });
    });
}

function createWebView(context: vscode.ExtensionContext): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'codePlayback',
        'Code Playback',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    panel.webview.html = getWebviewContent();
    return panel;
}

function handleMessages(panel: vscode.WebviewPanel, codeTracker: CodeTracker, terminalOutput: string[], debugEndPoints: number[]) {
    panel.webview.onDidReceiveMessage(
        message => {
            if (message.command === 'getChanges') {
                codeTracker.getChanges((changes) => {
                    panel.webview.postMessage({ command: 'update', changes, terminalOutput, debugEndPoints });
                });
            }
        },
        undefined,
        []
    );
}

function getWebviewContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8">
    <title>Code Playback</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.6.0/styles/atom-one-dark-reasonable.min.css">
    <style>
    pre {
        border: 1px solid #555;
    }
    #terminalOutput {
        white-space: pre-wrap;
        font-family: monospace;
        background-color: #000;
        color: #0f0;
        height: 200px;
        overflow: auto;
        padding: 5px;
    }
    input[type="range"] {
        width: 100%;
        background: linear-gradient(to right, #00f 0%, #333 0%);
    }
    input[type="range"]::-webkit-slider-runnable-track {
        height: 8px;
        background: transparent;
    }
    input[type="range"]::-webkit-slider-thumb {
        width: 8px;
        height: 8px;
        background: #f00;
        border-radius: 50%;
        cursor: pointer;
        margin-top: -2px;
    }
    #markers {
        width: 100%;
        height: 8px;
        position: relative;
        top: -16px;
    }
    .marker {
        position: absolute;
        width: 2px;
        height: 8px;
        background-color: red;
    }
    </style>
    </head>
    <body>
        <h1>Code Playback</h1>
        <pre><code id="codeArea" class="language-python" style="white-space: pre-wrap; font-family: monospace; height: 300px; overflow: auto; padding: 5px;"></code></pre>
        <pre id="terminalOutput"></pre>
        <input type="range" id="timeline" min="0" max="0" step="1" value="0" onchange="showChange(this.value)">
        <div id="markers"></div>
        <div style="margin-top: 10px;">
            <button id="playButton">Play</button>
            <button id="pauseButton">Pause</button>
        </div>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.6.0/highlight.min.js"></script>
        <script>
            const vscode = acquireVsCodeApi();
            let currentContent = [];
            let playInterval;
            let isPlaying = false;

            function applyChange(change) {
                const { line, column, indent, content, change_type } = change;
                if (!currentContent[line]) currentContent[line] = ' '.repeat(indent);

                if (change_type === 'delete') {
                    const endColumn = column + content.length;
                    currentContent[line] = currentContent[line].substring(0, column) + currentContent[line].substring(endColumn);
                } else {
                    const beforeText = currentContent[line].substring(0, column);
                    const afterText = currentContent[line].substring(column);
                    currentContent[line] = beforeText + content + afterText;
                }
            }

            function showChange(index) {
                const changes = window.changes.slice(0, parseInt(index) + 1);
                const terminalOutput = window.terminalOutput.slice(0, parseInt(index) + 1).join('\\n');
                currentContent = [];
                changes.forEach(change => applyChange(change));
                const codeArea = document.getElementById('codeArea');
                codeArea.textContent = currentContent.join('\\n');
                document.getElementById('terminalOutput').textContent = terminalOutput;
                hljs.highlightElement(codeArea);

                const timeline = document.getElementById('timeline');
                const fillPercent = (index / timeline.max) * 100;
                timeline.style.background = \`linear-gradient(to right, #00f \${fillPercent}%, #333 \${fillPercent}%)\`;
            }

            function play() {
                const timeline = document.getElementById('timeline');
                playInterval = setInterval(() => {
                    if (parseInt(timeline.value) < parseInt(timeline.max)) {
                        timeline.value = parseInt(timeline.value) + 1;
                        showChange(timeline.value);
                    } else {
                        clearInterval(playInterval);
                        isPlaying = false;
                        document.getElementById('playButton').disabled = false;
                        document.getElementById('pauseButton').disabled = true;
                    }
                }, 90);
            }

            function addMarkers(debugEndPoints) {
                const markersContainer = document.getElementById('markers');
                markersContainer.innerHTML = '';
                const timeline = document.getElementById('timeline');
                const max = parseInt(timeline.max);
                debugEndPoints.forEach(point => {
                    const marker = document.createElement('div');
                    marker.classList.add('marker');
                    marker.style.left = \`calc(\${(point / max) * 100}% - 1px)\`;
                    markersContainer.appendChild(marker);
                });
            }

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'update':
                        window.changes = message.changes;
                        window.terminalOutput = message.terminalOutput;
                        const timeline = document.getElementById('timeline');
                        timeline.max = window.changes.length - 1;
                        showChange(timeline.value);
                        addMarkers(message.debugEndPoints);
                        break;
                }
            });

            document.getElementById('playButton').addEventListener('click', () => {
                if (!isPlaying) {
                    isPlaying = true;
                    play();
                    document.getElementById('playButton').disabled = true;
                    document.getElementById('pauseButton').disabled = false;
                }
            });

            document.getElementById('pauseButton').addEventListener('click', () => {
                if (isPlaying) {
                    clearInterval(playInterval);
                    isPlaying = false;
                    document.getElementById('playButton').disabled = false;
                    document.getElementById('pauseButton').disabled = true;
                }
            });

            vscode.postMessage({ command: 'getChanges' });
        </script>
    </body>
    </html>`;
}

export function deactivate() {}

