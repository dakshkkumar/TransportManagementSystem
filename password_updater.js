const mysql = require('mysql2');

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "1806",
    database: "transportsystem"
});

db.connect((err) => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Connected to the database.');

    db.query('SELECT roll_no FROM student', (err, results) => {
        if (err) {
            console.error('Error fetching students:', err);
            db.end();
            return;
        }

        results.forEach((student) => {
            const roll_no = student.roll_no;
            const password = Math.floor(100000 + Math.random() * 900000).toString();

            db.query('UPDATE student SET password = ? WHERE roll_no = ?', [password, roll_no], (err, updateResult) => {
                if (err) {
                    console.error(`Error updating password for roll_no ${roll_no}:`, err);
                } else {
                    console.log(`Password updated for roll_no ${roll_no}`);
                }
            });
        });

        db.end();
    });
});