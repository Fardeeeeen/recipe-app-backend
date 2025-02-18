import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import recipeRoutes from './recipeRoutes.js';
import userRoutes from './userRoutes.js';

dotenv.config();
const app = express();



app.use(cors());
app.use(express.json());

console.log("🔍 Available Routes: /api/recipes");

// Routes
app.use('/api/recipes', recipeRoutes);
app.use('/api/users', userRoutes);

// Start Server
app.listen(5000, () => console.log("🚀 Server running on port 5000"));
