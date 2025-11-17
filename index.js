const express = require("express");
const mysql = require("mysql2");

const app = express();

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));

// Parse JSON bodies (as sent by API clients)
app.use(express.json());

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "1806",
    database: "transportsystem"
});

// Route for the login page
app.get("/", (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

// Handle login form submission for BOTH students and staff
app.post("/login", (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).send("Username and password are required.");
    }

    // First, try to log in as a student
    db.query(
        "SELECT s.Name, s.Roll_no, s.Route_no, d.Name AS driver_name, d.Driver_id, b.Bus_id AS bus_id, b.bus_no " +
        "FROM student s " +
        "LEFT JOIN route r ON s.route_no = r.Route_no " +
        "LEFT JOIN bus b ON r.Bus_id = b.Bus_id " +
        "LEFT JOIN driver d ON b.Driver_id = d.Driver_id " +
        "WHERE s.Roll_no = ? AND s.password = ?",
        [username, password], 
        (err, studentResults) => {
            if (err) {
                return res.status(500).send("Internal server error during student login check.");
            }

            if (studentResults.length > 0) {
                // Student authenticated successfully
                const student = studentResults[0];
                res.redirect(`/home?name=${encodeURIComponent(student.Name)}&rollNo=${encodeURIComponent(student.Roll_no)}&routeNo=${encodeURIComponent(student.Route_no)}&driverName=${encodeURIComponent(student.driver_name)}&driverId=${encodeURIComponent(student.Driver_id)}&busNo=${encodeURIComponent(student.bus_no)}`);
            } else {
                // If not a student, try to log in as staff
                const staffIdInt = parseInt(username, 10);
                if (isNaN(staffIdInt)) {
                    // If username is not a number, it can't be a staff ID, so fail
                    return res.status(401).send("Invalid username or password.");
                }

                db.query(
                    "SELECT * FROM `staff` WHERE `Staff_id` = ? AND `password` = ?",
                    [staffIdInt, password],
                    (err, staffResults) => {
                        if (err) {
                            return res.status(500).send("Internal server error during staff login check.");
                        }

                        if (staffResults.length > 0) {
                            // Staff authenticated successfully
                            const staffMember = staffResults[0];
                            res.redirect(`/staff_home?id=${encodeURIComponent(staffMember.Staff_id)}&name=${encodeURIComponent(staffMember.Name)}&designation=${encodeURIComponent(staffMember.Designation)}`);
                        } else {
                            // If not a student and not a staff, then fail
                            res.status(401).send("Invalid username or password.");
                        }
                    }
                );
            }
        }
    );
});

// API endpoint to get shuttle details
app.get("/api/shuttle-details", (req, res) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    db.query(
        "SELECT s.Bus_id, b.bus_no, b.Capacity, d.Name AS driver_name, d.Driver_id, s.Time AS departure_time, s.Type, " +
        "(SELECT COUNT(*) FROM shuttle_booking sb WHERE sb.type = s.Type AND sb.booking_date = ? AND sb.status = 'booked') AS currentBookings " +
        "FROM shuttle s " +
        "JOIN bus b ON s.Bus_id = b.Bus_id " +
        "JOIN driver d ON s.Driver_id = d.Driver_id",
        [today],
        (err, results) => {
            if (err) {
                return res.status(500).send("Internal server error.");
            }
            res.json(results);
        }
    );
});

// API endpoint to get driver details
app.get("/api/driver-details/:driverId", (req, res) => {
    const { driverId } = req.params;

    if (!driverId) {
        return res.status(400).send("Driver ID is required.");
    }

    db.query("SELECT Driver_id, Name, Mobile, License_id FROM driver WHERE Driver_id = ?", [driverId], (err, results) => {
        if (err) {
            return res.status(500).send("Internal server error.");
        }
        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.status(404).send("Driver not found.");
        }
    });
});

// API endpoint to opt-in for shuttle service
app.post("/api/shuttle/opt-in", (req, res) => {
    const { rollNo, type, bookingDate } = req.body;

    if (!rollNo || !type || !bookingDate) {
        return res.status(400).send("Missing required booking information.");
    }

    // Check for an existing booking first (active or cancelled)
    db.query("SELECT * FROM shuttle_booking WHERE roll_no = ? AND type = ? AND booking_date = ?", [rollNo, type, bookingDate], (err, existingBookings) => {
        if (err) {
            return res.status(500).send("Database error checking for existing bookings.");
        }

        const existingBooking = existingBookings[0];

        // Get shuttle capacity details
        db.query("SELECT s.Bus_id, b.Capacity FROM shuttle s JOIN bus b ON s.Bus_id = b.Bus_id WHERE s.Type = ?", [type], (err, shuttleResults) => {
            if (err) {
                return res.status(500).send("Database error getting shuttle details.");
            }
            if (shuttleResults.length === 0) {
                return res.status(404).send("Shuttle type not found.");
            }

            const capacity = shuttleResults[0].Capacity;

            // Count current active bookings
            db.query("SELECT COUNT(*) AS bookings FROM shuttle_booking WHERE type = ? AND booking_date = ? AND status = 'booked'", [type, bookingDate], (err, bookingCountResult) => {
                if (err) {
                    return res.status(500).send("Database error checking bookings.");
                }
                const currentBookings = bookingCountResult[0].bookings;

                // Logic for handling existing vs. new bookings
                if (existingBooking) {
                    if (existingBooking.status === 'booked') {
                        return res.status(409).send("You have already booked this shuttle.");
                    }
                    // If booking was cancelled, try to re-book
                    if (currentBookings >= capacity) {
                        return res.status(409).send("Shuttle is already full.");
                    }
                    // Reactivate the booking
                    db.query("UPDATE shuttle_booking SET status = 'booked' WHERE id = ?", [existingBooking.id], (err, updateResult) => {
                        if (err) {
                            return res.status(500).send("Error reactivating your booking.");
                        }
                        res.status(200).json({ ...existingBooking, status: 'booked' });
                    });
                } else {
                    // No existing booking, create a new one
                    if (currentBookings >= capacity) {
                        return res.status(409).send("Shuttle is already full.");
                    }
                    db.query("INSERT INTO shuttle_booking (roll_no, type, booking_date, status) VALUES (?, ?, ?, 'booked')", [rollNo, type, bookingDate], (err, insertResult) => {
                        if (err) {
                            return res.status(500).send("Error creating booking.");
                        }
                        const newBookingId = insertResult.insertId;
                        db.query("SELECT * FROM shuttle_booking WHERE id = ?", [newBookingId], (err, newBookingResult) => {
                            if (err) {
                                return res.status(500).send("Error fetching new booking.");
                            }
                            res.status(201).json(newBookingResult[0]);
                        });
                    });
                }
            });
        });
    });
});

// API endpoint to get a student's bookings
app.get("/api/my-bookings/:rollNo", (req, res) => {
    const { rollNo } = req.params;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    db.query(
        "SELECT sb.id, sb.type, sb.booking_date, s.Bus_id, s.Time AS shuttle_time " +
        "FROM shuttle_booking sb " +
        "JOIN shuttle s ON sb.type = s.Type " +
        "WHERE sb.roll_no = ? AND sb.status = 'booked' AND sb.booking_date = ?",
        [rollNo, today],
        (err, results) => {
            if (err) {
                return res.status(500).send("Database error fetching your bookings.");
            }
            res.json(results);
        }
    );
});

// API endpoint to cancel a shuttle booking
app.post("/api/shuttle/cancel", (req, res) => {
    const { bookingId } = req.body;
    if (!bookingId) {
        return res.status(400).send("Booking ID is required to cancel.");
    }

    db.query(
        "UPDATE shuttle_booking SET status = 'cancelled' WHERE id = ?",
        [bookingId],
        (err, results) => {
            if (err) {
                return res.status(500).send("Error cancelling your booking.");
            }
            if (results.affectedRows === 0) {
                return res.status(404).send("Booking not found or already cancelled.");
            }
            res.status(200).send("Booking cancelled successfully.");
        }
    );
});

// API endpoint for students to submit a complaint
app.post("/api/complaints", (req, res) => {
    const { rollNo, typeId, type, description, referenceId } = req.body;
    if (!rollNo || !typeId || !type || !description) {
        return res.status(400).send("Missing required complaint information.");
    }

    const rollNoInt = parseInt(rollNo, 10);
    const typeIdInt = parseInt(typeId, 10);
    // referenceId can be optional, so we parse it if it exists, otherwise null
    const referenceIdInt = referenceId ? parseInt(referenceId, 10) : null;

    if (isNaN(rollNoInt) || isNaN(typeIdInt) || (referenceId && isNaN(referenceIdInt))) {
        return res.status(400).send("Invalid Roll No, Complaint Type ID, or Reference ID.");
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    db.query(
        "INSERT INTO complaint (Roll_no, Type_id, Type, Description, Date, Status, Reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [rollNoInt, typeIdInt, type, description, today, 'in-progress', referenceIdInt],
        (err, results) => {
            if (err) {
                console.error("Error submitting complaint:", err);
                return res.status(500).send("Error submitting complaint.");
            }
            res.status(201).send("Complaint submitted successfully.");
        }
    );
});

// --- Route Approval Endpoints ---

// GET all routes for the dropdown
app.get("/api/routes", (req, res) => {
    db.query("SELECT Route_no, Route_name FROM route ORDER BY Route_no", (err, results) => {
        if (err) {
            return res.status(500).send("Database error fetching routes.");
        }
        res.json(results);
    });
});

// GET a student's approval status
app.get("/api/approval/status/:rollNo", (req, res) => {
    const { rollNo } = req.params;
    db.query(
        "SELECT a.Route_no, a.status, a.Approved_by, st.Name as approved_by_name, r.Route_name, r.Bus_id, b.bus_no, d.Name as driver_name, d.Driver_id " +
        "FROM approval a " +
        "JOIN route r ON a.Route_no = r.Route_no " +
        "LEFT JOIN bus b ON r.Bus_id = b.Bus_id " +
        "LEFT JOIN driver d ON b.Driver_id = d.Driver_id " +
        "LEFT JOIN staff st ON a.Approved_by = st.Staff_id " +
        "WHERE a.Roll_no = ? ORDER BY a.Date DESC LIMIT 1",
        [rollNo],
        (err, results) => {
            if (err) {
                return res.status(500).send("Database error fetching approval status.");
            }
            if (results.length > 0) {
                res.json(results[0]);
            } else {
                res.json(null); // No pending or approved request found
            }
        }
    );
});

// POST a new approval request
app.post("/api/approval/request", (req, res) => {
    const { rollNo, routeNo } = req.body;
    if (!rollNo || !routeNo) {
        return res.status(400).send("Roll number and Route number are required.");
    }

    // Check if there's already a pending/approved request
    db.query("SELECT * FROM approval WHERE Roll_no = ? AND (status = 'pending' OR status = 'approved')", [rollNo], (err, results) => {
        if (err) {
            return res.status(500).send("Database error checking for existing requests.");
        }
        if (results.length > 0) {
            return res.status(409).send("You already have a pending or approved request.");
        }

        // Insert new request
        const today = new Date().toISOString().slice(0, 10); // Format as YYYY-MM-DD
        db.query("INSERT INTO approval (Roll_no, Route_no, Date, status) VALUES (?, ?, ?, 'pending')", [rollNo, routeNo, today], (err, insertResult) => {
            if (err) {
                console.error("Error creating approval request:", err);
                return res.status(500).send("Error creating approval request.");
            }
            res.status(201).send("Approval request submitted successfully.");
        });
    });
});

// GET all pending approvals for the staff dashboard
app.get("/api/approvals/pending", (req, res) => {
    db.query(
        "SELECT a.Approval_id, a.Date, s.Roll_no, s.Name as student_name, r.Route_no, r.Route_name " +
        "FROM approval a " +
        "JOIN student s ON a.Roll_no = s.Roll_no " +
        "JOIN route r ON a.Route_no = r.Route_no " +
        "WHERE a.status = 'pending' ORDER BY a.Date ASC",
        (err, results) => {
            if (err) {
                return res.status(500).send("Database error fetching pending approvals.");
            }
            res.json(results);
        }
    );
});

// POST to approve a request
app.post("/api/approvals/approve", (req, res) => {
    const { approvalId, staffId } = req.body;
    if (!approvalId || !staffId) {
        return res.status(400).send("Approval ID and Staff ID are required.");
    }

    db.query(
        "UPDATE approval SET status = 'approved', Approved_by = ? WHERE Approval_id = ?",
        [staffId, approvalId],
        (err, results) => {
            if (err) {
                return res.status(500).send("Error approving request.");
            }
            if (results.affectedRows === 0) {
                return res.status(404).send("Approval request not found or already actioned.");
            }
            res.status(200).send("Request approved successfully.");
        }
    );
});

// API endpoint for staff to view all complaints
app.get("/api/complaints", (req, res) => {
    db.query(
        "SELECT c.Complaint_id, c.Roll_no, s.Name as student_name, c.Type_id, c.Type, c.Description, c.Date, c.Status, c.Reference_id " +
        "FROM complaint c JOIN student s ON c.Roll_no = s.Roll_no WHERE c.Status != 'resolved' ORDER BY c.Date DESC",
        (err, results) => {
            if (err) {
                console.error("Error fetching complaints:", err);
                return res.status(500).send("Error fetching complaints.");
            }
            res.json(results);
        }
    );
});

// API endpoint to get details of all SPOCs
app.get("/api/spocs", (req, res) => {
    db.query(
        "SELECT sp.Roll_no, st.Name AS student_name, st.Mobile, st.Email, sp.Route_no, r.Route_name " +
        "FROM spoc sp " +
        "JOIN student st ON sp.Roll_no = st.Roll_no " +
        "JOIN route r ON sp.Route_no = r.Route_no " +
        "ORDER BY sp.Route_no, st.Name",
        (err, results) => {
            if (err) {
                console.error("Error fetching SPOC details:", err);
                return res.status(500).send("Error fetching SPOC details.");
            }
            res.json(results);
        }
    );
});

// API endpoint to get SPOC for a specific route
app.get("/api/spocs/:routeNo", (req, res) => {
    const { routeNo } = req.params;
    const routeNoInt = parseInt(routeNo, 10);

    if (isNaN(routeNoInt)) {
        return res.status(400).send("Invalid Route Number.");
    }

    db.query(
        "SELECT sp.Roll_no, st.Name AS student_name, st.Mobile, st.Email, sp.Route_no, r.Route_name " +
        "FROM spoc sp " +
        "JOIN student st ON sp.Roll_no = st.Roll_no " +
        "JOIN route r ON sp.Route_no = r.Route_no " +
        "WHERE sp.Route_no = ?",
        [routeNoInt],
        (err, results) => {
            if (err) {
                console.error("Error fetching SPOC for route:", err);
                return res.status(500).send("Error fetching SPOC for route.");
            }
            res.json(results);
        }
    );
});

// API endpoint for staff to update complaint status
app.put("/api/complaints/:complaintId", (req, res) => {
    const { complaintId } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).send("Complaint status is required.");
    }

    db.query(
        "UPDATE complaint SET Status = ? WHERE Complaint_id = ?",
        [status, complaintId],
        (err, results) => {
            if (err) {
                console.error("Error updating complaint status:", err);
                return res.status(500).send("Error updating complaint status.");
            }
            if (results.affectedRows === 0) {
                return res.status(404).send("Complaint not found.");
            }
            res.status(200).send("Complaint status updated successfully.");
        }
    );
});

// API endpoint to get a student's complaints
app.get("/api/my-complaints/:rollNo", (req, res) => {
    const { rollNo } = req.params;
    if (!rollNo) {
        return res.status(400).send("Roll number is required.");
    }

    db.query(
        "SELECT Complaint_id, Type, Description, Date, Status FROM complaint WHERE Roll_no = ? ORDER BY Date DESC",
        [rollNo],
        (err, results) => {
            if (err) {
                console.error("Error fetching student complaints:", err);
                return res.status(500).send("Error fetching student complaints.");
            }
            res.json(results);
        }
    );
});



// Route to setup the database
app.get("/setup-database", (req, res) => {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS shuttle_booking (
            id INT AUTO_INCREMENT PRIMARY KEY,
            roll_no VARCHAR(255) NOT NULL,
            bus_id VARCHAR(255) NOT NULL,
            booking_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
    db.query(createTableQuery, (err, results) => {
        if (err) {
            return res.status(500).send("Error creating shuttle_booking table.");
        }
        res.status(200).send("shuttle_booking table created successfully (if it didn't exist).");
    });
});


// Route for the home page (after successful login)
app.get("/home", (req, res) => {
    res.sendFile(__dirname + '/public/home.html');
});

// Route for the staff home page (after successful login)
app.get("/staff_home", (req, res) => {
    res.sendFile(__dirname + '/public/staff_home.html');
});

// API endpoint to get students on the same route
app.get("/api/students-on-route/:routeNo", (req, res) => {
    const { routeNo } = req.params;

    if (!routeNo) {
        return res.status(400).send("Route number is required.");
    }

    // First, get the SPOC for the route
    db.query("SELECT Roll_no FROM spoc WHERE Route_no = ?", [routeNo], (err, spocResult) => {
        if (err) {
            return res.status(500).send("Internal server error.");
        }

        const spocRollNo = spocResult.length > 0 ? spocResult[0].Roll_no : null;

        // Then, get all students on the route
        db.query(
            "SELECT Roll_no, Name, Mobile FROM student WHERE route_no = ?",
            [routeNo],
            (err, studentResults) => {
                if (err) {
                    return res.status(500).send("Internal server error.");
                }

                const studentsWithSpoc = studentResults.map(student => ({
                    ...student,
                    is_spoc: student.Roll_no === spocRollNo,
                }));

                res.json(studentsWithSpoc);
            }
        );
    });
});

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
