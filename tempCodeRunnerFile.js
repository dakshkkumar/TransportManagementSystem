 res.status(500).send("DB Error: " + err.message);
        }

        let html = "<h2>Users:</h2>";
        results.forEach(row => {
            html += `ID: ${row.roll_no} - Name: ${row.name}<br>`;
        });
        res