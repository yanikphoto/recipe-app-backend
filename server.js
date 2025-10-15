const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Data file path
const DATA_FILE = path.join(__dirname, 'data.json');

// Helper functions
const readData = () => {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      // Create initial data file if it doesn't exist
      const initialData = { recipes: [], groceryList: [] };
      fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
      return initialData;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('Error reading data:', error);
    return { recipes: [], groceryList: [] };
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing data:', error);
    return false;
  }
};

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Recipe App API is running!' });
});

// Get all data
app.get('/api/data', (req, res) => {
  try {
    const data = readData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read data' });
  }
});

// Save all data
app.post('/api/data', (req, res) => {
  try {
    const data = req.body;
    
    // Validate data structure
    if (!data.recipes || !Array.isArray(data.recipes) || 
        !data.groceryList || !Array.isArray(data.groceryList)) {
      return res.status(400).json({ error: 'Invalid data structure' });
    }
    
    const success = writeData(data);
    
    if (success) {
      res.json({ success: true, message: 'Data saved successfully' });
    } else {
      res.status(500).json({ error: 'Failed to save data' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});