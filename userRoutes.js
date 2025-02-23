import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './database.js';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 🟢 User Signup
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    // Validate password strength.
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!strongPasswordRegex.test(password)) {
      return res.status(400).json({ 
        message: "Password must be at least 8 characters long and include uppercase, lowercase, a number, and a special character" 
      });
    }

    const existingUser = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: "User with this email already exists" });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query("INSERT INTO users (username, email, password) VALUES ($1, $2, $3)", 
      [username, email, hashedPassword]);

    return res.json({ message: "User registered successfully" });
  } catch (error) {
    console.error("Error in register:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// 🟢 User Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.query("SELECT * FROM users WHERE email = $1", [email]);

    if (user.rows.length === 0 || !(await bcrypt.compare(password, user.rows[0].password))) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ email }, "secret_key", { expiresIn: '1h' });
    return res.json({ token, user_id: user.rows[0].id });
  } catch (error) {
    console.error("Error in login:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// 🟢 Forgot Password - Send Reset Email
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const userResult = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      // Do not reveal whether the email exists.
      return res.json({ message: "If that email is registered, you will receive a reset link." });
    }
    
    const user = userResult.rows[0];
    const resetToken = jwt.sign({ email: user.email }, "reset_secret_key", { expiresIn: '1h' });
    const resetLink = `https:///reset-password?token=${resetToken}`;
    
    const mailOptions = {
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Password Reset Request",
      text: `Click the link below to reset your password: ${resetLink}`,
      html: `<p>Click the link below to reset your password:</p><a href="${resetLink}">${resetLink}</a>`
    };
    
    await transporter.sendMail(mailOptions);
    return res.json({ message: "If that email is registered, you will receive a reset link." });
  } catch (error) {
    console.error("Error in forgot-password:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

// 🟢 Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const decoded = jwt.verify(token, "reset_secret_key");
    const email = decoded.email;
    
    // Validate strong password.
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!strongPasswordRegex.test(newPassword)) {
      return res.status(400).json({ 
        message: "Password must be at least 8 characters long and include uppercase, lowercase, a number, and a special character" 
      });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE users SET password = $1 WHERE email = $2", [hashedPassword, email]);
    return res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error in reset-password:", error);
    return res.status(400).json({ message: "Invalid or expired token" });
  }
});

export default router;
