// database.ts
import * as sqlite3 from 'sqlite3';
import * as path from 'path';

export class CodeTracker {
    private db: sqlite3.Database;

    constructor() {
        console.log("Creating CodeTracker instance...");
        const dbPath = path.resolve(__dirname, 'code_tracker.db');
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database', err);
            } else {
                console.log("Database opened successfully.");
                this.initializeDatabase();
            }
        });
    }

    private initializeDatabase() {
        const query = `
            CREATE TABLE IF NOT EXISTS changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT (datetime('now','localtime')),
                file_name TEXT,
                change_type TEXT,
                content TEXT,
                line INTEGER,
                column INTEGER,
                indent INTEGER DEFAULT 0,
                terminal_output TEXT
            );
        `;
        this.db.run(query, (err) => {
            if (err) {
                console.error('Error creating table', err);
            }
        });
    }

    public recordChange(fileName: string, changeType: string, content: string, line: number, column: number, indent: number, terminalOutput: string) {
        const query = `INSERT INTO changes (file_name, change_type, content, line, column, indent, terminal_output) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        this.db.run(query, [fileName, changeType, content, line, column, indent, terminalOutput], (err) => {
            if (err) {
                console.error('Error inserting data', err);
            }
        });
    }

    public batchRecordChanges(changes: any[], terminalOutput: string) {
        const query = `INSERT INTO changes (file_name, change_type, content, line, column, indent, terminal_output) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const stmt = this.db.prepare(query);
        this.db.serialize(() => {
            this.db.run("BEGIN TRANSACTION");
            changes.forEach(change => {
                stmt.run([change.fileName, change.changeType, change.affectedContent, change.line, change.character, change.indent, terminalOutput]);
            });
            this.db.run("COMMIT");
        });
        stmt.finalize();
    }

    public getChanges(callback: (changes: any[]) => void) {
        const query = `SELECT * FROM changes ORDER BY timestamp ASC`;
        this.db.all(query, [], (err, rows) => {
            if (err) {
                console.error('Error retrieving data', err);
                callback([]);
            } else {
                callback(rows);
            }
        });
    }

    public deactivate() {
        this.db.close();
    }
}