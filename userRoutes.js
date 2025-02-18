import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './database.js';

const router = express.Router();

// 🟢 User Signup
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;

    const existingUser = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    
    if (existingUser.rows.length > 0) {
        return res.status(400).json({ message: "User with this email already exists" });
    }

    
    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query("INSERT INTO users (username, email, password) VALUES ($1, $2, $3)", 
        [username, email, hashedPassword]);

    res.json({ message: "User registered successfully" });
});

// 🟢 User Login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await db.query("SELECT * FROM users WHERE email = $1", [email]);

    if (user.rows.length === 0 || !(await bcrypt.compare(password, user.rows[0].password))) {
        return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ email }, "secret_key", { expiresIn: '1h' });
    res.json({ token });
});

export default router;
