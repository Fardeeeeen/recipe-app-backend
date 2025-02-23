import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './database.js';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config(); 

const router = express.Router();

// Create a transporter using your Mailtrap (or other SMTP) credentials.
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
  const { username, email, password } = req.body;

  // Validate password strength (minimum 8 characters, one uppercase, one lowercase, one number, one special character)
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
  res.json({ token, user_id: user.rows[0].id });
});

// 🟢 Forgot Password - Send Reset Email
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const userResult = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (userResult.rows.length === 0) {
      // Do not reveal whether the email exists
      return res.json({ message: "If that email is registered, you will receive a reset link." });
    }
    
    const user = userResult.rows[0];
    // Create a reset token that expires in 1 hour
    const resetToken = jwt.sign({ email: user.email }, "reset_secret_key", { expiresIn: '1h' });
    const resetLink = `https://live.smtp.mailtrap.io/reset-password?token=${resetToken}`;
    console.log("Password reset link:", resetLink);
    
    // Define email options
    const mailOptions = {
      from: process.env.SMTP_FROM, 
      to: email,
      subject: "Password Reset Request",
      text: `Click the link below to reset your password: ${resetLink}`,
      html: `<p>Click the link below to reset your password:</p><a href="${resetLink}">${resetLink}</a>`
    };
    
    // Send the email
    await transporter.sendMail(mailOptions);
    
    res.json({ message: "If that email is registered, you will receive a reset link." });
  } catch (error) {
    console.error("Error in forgot-password:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// 🟢 Reset Password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const decoded = jwt.verify(token, "reset_secret_key");
    const email = decoded.email;
    
    // Validate strong password on backend
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!strongPasswordRegex.test(newPassword)) {
      return res.status(400).json({ 
        message: "Password must be at least 8 characters long and include uppercase, lowercase, a number, and a special character" 
      });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE users SET password = $1 WHERE email = $2", [hashedPassword, email]);
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error in reset-password:", error);
    res.status(400).json({ message: "Invalid or expired token" });
  }
});

export default router;
