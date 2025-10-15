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

// 🔥 NEW: Merge recipes properly
const mergeRecipes = (existingRecipes, newRecipes) => {
  const recipeMap = new Map();
  
  // Add existing recipes first
  existingRecipes.forEach(recipe => {
    recipeMap.set(recipe.id, recipe);
  });
  
  // Add/override with new recipes
  newRecipes.forEach(recipe => {
    recipeMap.set(recipe.id, recipe);
  });
  
  return Array.from(recipeMap.values());
};

// 🔥 NEW: Merge grocery items properly
const mergeGroceryList = (existingItems, newItems) => {
  const itemMap = new Map();
  
  // Add existing items first
  existingItems.forEach(item => {
    itemMap.set(item.id, item);
  });
  
  // Add/override with new items
  newItems.forEach(item => {
    itemMap.set(item.id, item);
  });
  
  return Array.from(itemMap.values());
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

// 🔥 FIXED: Save all data with proper merging
app.post('/api/data', (req, res) => {
  try {
    const newData = req.body;
    
    // Validate data structure
    if (!newData.recipes || !Array.isArray(newData.recipes) || 
        !newData.groceryList || !Array.isArray(newData.groceryList)) {
      return res.status(400).json({ error: 'Invalid data structure' });
    }
    
    // 🔥 CRITICAL FIX: Read existing data first
    const existingData = readData();
    
    // 🔥 CRITICAL FIX: Merge data instead of overwriting
    const mergedData = {
      recipes: mergeRecipes(existingData.recipes, newData.recipes),
      groceryList: mergeGroceryList(existingData.groceryList, newData.groceryList),
      lastUpdated: new Date().toISOString()
    };
    
    console.log('📥 Merging data:');
    console.log('  Existing recipes:', existingData.recipes.length);
    console.log('  New recipes:', newData.recipes.length);
    console.log('  Merged recipes:', mergedData.recipes.length);
    
    const success = writeData(mergedData);
    
    if (success) {
      // 🔥 IMPORTANT: Return the merged data, not just success message
      res.json(mergedData);
    } else {
      res.status(500).json({ error: 'Failed to save data' });
    }
  } catch (error) {
    console.error('❌ Error in POST /api/data:', error);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

// 🔥 NEW: Add single recipe endpoint
app.post('/api/recipes', (req, res) => {
  try {
    const newRecipe = req.body;
    
    if (!newRecipe || !newRecipe.id) {
      return res.status(400).json({ error: 'Invalid recipe data' });
    }
    
    const existingData = readData();
    
    // Check if recipe already exists
    const existingIndex = existingData.recipes.findIndex(r => r.id === newRecipe.id);
    
    if (existingIndex >= 0) {
      // Update existing recipe
      existingData.recipes[existingIndex] = newRecipe;
    } else {
      // Add new recipe to the beginning
      existingData.recipes.unshift(newRecipe);
    }
    
    existingData.lastUpdated = new Date().toISOString();
    
    const success = writeData(existingData);
    
    if (success) {
      console.log('✅ Recipe saved:', newRecipe.title);
      res.json(newRecipe);
    } else {
      res.status(500).json({ error: 'Failed to save recipe' });
    }
  } catch (error) {
    console.error('❌ Error saving recipe:', error);
    res.status(500).json({ error: 'Failed to save recipe' });
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