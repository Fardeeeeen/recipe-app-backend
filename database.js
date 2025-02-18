// Import the pg library as a default import
import pkg from 'pg';
const { Pool } = pkg;

// Load environment variables
import 'dotenv/config';

// 🟢 Configure Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 🟢 Test Database Connection
pool.connect()
    .then(() => console.log("✅ Connected to PostgreSQL Database"))
    .catch(err => console.error("❌ Database Connection Error:", err));

// Export the pool for use in other modules
export default pool;