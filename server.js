
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// 🔥 FIX: Use a more explicit CORS configuration to prevent potential fetch errors.
const corsOptions = {
  origin: '*', // Allow all origins
  methods: ['GET', 'POST'], // Specify allowed methods
  allowedHeaders: ['Content-Type'], // Specify allowed headers
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Enable pre-flight for all routes

app.use(express.json({ limit: '10mb' }));

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
    console.error('Error reading data file, returning empty state:', error);
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

// 🔥 HARDENED: Merge recipes properly, filtering out invalid entries.
const mergeRecipes = (existingRecipes, newRecipes) => {
  const recipeMap = new Map();
  
  // Sanitize and add existing recipes first
  // This prevents crashes if the arrays contain null, undefined, or objects without an ID.
  (existingRecipes || []).filter(r => r && typeof r === 'object' && r.id).forEach(recipe => {
    recipeMap.set(recipe.id, recipe);
  });
  
  // Sanitize and add/override with new recipes
  (newRecipes || []).filter(r => r && typeof r === 'object' && r.id).forEach(recipe => {
    recipeMap.set(recipe.id, recipe);
  });
  
  return Array.from(recipeMap.values());
};

// 🔥 HARDENED: Merge grocery items properly, filtering out invalid entries.
const mergeGroceryList = (existingItems, newItems) => {
  const itemMap = new Map();
  
  // Sanitize and add existing items first
  (existingItems || []).filter(i => i && typeof i === 'object' && i.id).forEach(item => {
    itemMap.set(item.id, item);
  });
  
  // Sanitize and add/override with new items
  (newItems || []).filter(i => i && typeof i === 'object' && i.id).forEach(item => {
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
    console.error('Error in GET /api/data:', error);
    res.status(500).json({ error: 'Failed to read data' });
  }
});

// Save all data with proper merging
app.post('/api/data', (req, res) => {
  try {
    const newData = req.body;
    
    // Basic structure validation
    if (!newData || typeof newData !== 'object' || !Array.isArray(newData.recipes) || !Array.isArray(newData.groceryList)) {
      return res.status(400).json({ error: 'Invalid data structure: body must be an object with recipes and groceryList arrays.' });
    }
    
    const existingData = readData();
    
    // The merge functions now handle sanitation internally, preventing crashes from bad data.
    const mergedData = {
      recipes: mergeRecipes(existingData.recipes, newData.recipes),
      groceryList: mergeGroceryList(existingData.groceryList, newData.groceryList),
      lastUpdated: new Date().toISOString()
    };
    
    console.log('📥 Merging data:');
    console.log('  Existing recipes:', (existingData.recipes || []).length);
    console.log('  New recipes from client:', newData.recipes.length);
    console.log('  Merged recipes after sanitation:', mergedData.recipes.length);
    console.log('  Merged grocery items after sanitation:', mergedData.groceryList.length);
    
    const success = writeData(mergedData);
    
    if (success) {
      // Return the final, merged, and sanitized data to the client.
      res.status(200).json(mergedData);
    } else {
      res.status(500).json({ error: 'Failed to save data' });
    }
  } catch (error) {
    console.error('❌ Unhandled error in POST /api/data:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Add/update a single recipe
app.post('/api/recipes', (req, res) => {
  try {
    const newRecipe = req.body;
    
    // 🔥 HARDENED: Add more robust validation for the recipe object.
    if (!newRecipe || typeof newRecipe !== 'object' || !newRecipe.id || !newRecipe.title) {
      return res.status(400).json({ error: 'Invalid recipe data: must be an object with at least an id and title.' });
    }
    
    const existingData = readData();
    
    const recipeList = existingData.recipes || [];
    const existingIndex = recipeList.findIndex(r => r.id === newRecipe.id);
    
    if (existingIndex >= 0) {
      // Update existing recipe
      recipeList[existingIndex] = newRecipe;
      console.log('📝 Recipe updated:', newRecipe.title);
    } else {
      // Add new recipe to the beginning
      recipeList.unshift(newRecipe);
      console.log('✅ Recipe added:', newRecipe.title);
    }
    
    const dataToSave = {
        ...existingData,
        recipes: recipeList,
        lastUpdated: new Date().toISOString()
    };
    
    const success = writeData(dataToSave);
    
    if (success) {
      res.status(200).json(newRecipe);
    } else {
      res.status(500).json({ error: 'Failed to save recipe' });
    }
  } catch (error) {
    console.error('❌ Error saving recipe:', error);
    res.status(500).json({ error: 'An internal server error occurred while saving the recipe.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});