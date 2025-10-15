

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises; // Use the promises version of fs for async operations
const fsSync = require('fs'); // For one-time sync check on startup
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));

const DATA_FILE = path.join(__dirname, 'data.json');

// --- Simple Async Lock to prevent race conditions ---
let isLocked = false;
const withLock = async (fn) => {
    // Wait if the file is already being accessed.
    while (isLocked) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    isLocked = true;
    try {
        // Execute the file operation
        return await fn();
    } finally {
        // Always release the lock
        isLocked = false;
    }
};
// --- End of Lock ---

// Helper functions are now async and wrapped in the lock to be thread-safe
const readData = () => withLock(async () => {
    try {
        // Use synchronous existsSync only for initial setup check. It's safe on startup.
        if (!fsSync.existsSync(DATA_FILE)) {
            const initialData = { recipes: [], groceryList: [] };
            await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const fileContent = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(fileContent);
    } catch (error) {
        console.error('Error reading data file, returning empty state:', error);
        return { recipes: [], groceryList: [] };
    }
});

const writeData = (data) => withLock(async () => {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing data:', error);
        return false;
    }
});


// HARDENED: Merge recipes properly, filtering out invalid entries.
const mergeRecipes = (existingRecipes, newRecipes) => {
  const recipeMap = new Map();
  
  (existingRecipes || []).filter(r => r && typeof r === 'object' && r.id).forEach(recipe => {
    recipeMap.set(recipe.id, recipe);
  });
  
  (newRecipes || []).filter(r => r && typeof r === 'object' && r.id).forEach(recipe => {
    recipeMap.set(recipe.id, recipe);
  });
  
  return Array.from(recipeMap.values());
};

// HARDENED: Merge grocery items properly, filtering out invalid entries.
const mergeGroceryList = (existingItems, newItems) => {
  const itemMap = new Map();
  
  (existingItems || []).filter(i => i && typeof i === 'object' && i.id).forEach(item => {
    itemMap.set(item.id, item);
  });
  
  (newItems || []).filter(i => i && typeof i === 'object' && i.id).forEach(item => {
    itemMap.set(item.id, item);
  });
  
  return Array.from(itemMap.values());
};

// Routes - now all async to handle async file I/O
app.get('/', (req, res) => {
  res.json({ message: 'Recipe App API is running!' });
});

// Get all data
app.get('/api/data', async (req, res) => {
  try {
    const data = await readData();
    res.json(data);
  } catch (error) {
    console.error('Error in GET /api/data:', error);
    res.status(500).json({ error: 'Failed to read data' });
  }
});

// Save all data with proper merging (used for bulk updates like reordering)
app.post('/api/data', async (req, res) => {
  try {
    const newData = req.body;
    
    if (!newData || typeof newData !== 'object' || !Array.isArray(newData.recipes) || !Array.isArray(newData.groceryList)) {
      return res.status(400).json({ error: 'Invalid data structure: body must be an object with recipes and groceryList arrays.' });
    }
    
    const existingData = await readData();
    
    const mergedData = {
      recipes: mergeRecipes(existingData.recipes, newData.recipes),
      groceryList: mergeGroceryList(existingData.groceryList, newData.groceryList),
      lastUpdated: new Date().toISOString()
    };
    
    const success = await writeData(mergedData);
    
    if (success) {
      res.status(200).json(mergedData);
    } else {
      res.status(500).json({ error: 'Failed to save data due to file system error.' });
    }
  } catch (error) {
    console.error('❌ Unhandled error in POST /api/data:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// Add/update a single recipe
app.post('/api/recipes', async (req, res) => {
  try {
    const newRecipe = req.body;
    if (!newRecipe || !newRecipe.id || !newRecipe.title) {
      return res.status(400).json({ error: 'Invalid recipe data' });
    }
    
    const data = await readData();
    const existingIndex = data.recipes.findIndex(r => r.id === newRecipe.id);
    if (existingIndex >= 0) {
      data.recipes[existingIndex] = newRecipe;
    } else {
      data.recipes.unshift(newRecipe);
    }
    await writeData(data);
    res.status(200).json(newRecipe);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save recipe' });
  }
});

// Delete a single recipe
app.delete('/api/recipes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await readData();
        const initialLength = data.recipes.length;
        data.recipes = data.recipes.filter(r => r.id !== id);
        if (data.recipes.length < initialLength) {
            await writeData(data);
            res.status(200).json({ message: 'Recipe deleted' });
        } else {
            res.status(404).json({ message: 'Recipe not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete recipe' });
    }
});

// Add a single grocery item
app.post('/api/grocery', async (req, res) => {
    try {
        const newItem = req.body;
        if (!newItem || !newItem.id || !newItem.name) {
            return res.status(400).json({ error: 'Invalid grocery item' });
        }
        const data = await readData();
        // Prevent duplicates just in case
        if (!data.groceryList.some(i => i.id === newItem.id)) {
            data.groceryList.unshift(newItem);
            await writeData(data);
        }
        res.status(200).json(newItem);
    } catch (error) {
        res.status(500).json({ error: 'Failed to save grocery item' });
    }
});

// Delete a single grocery item
app.delete('/api/grocery/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await readData();
        const initialLength = data.groceryList.length;
        data.groceryList = data.groceryList.filter(i => i.id !== id);
        if (data.groceryList.length < initialLength) {
            await writeData(data);
            res.status(200).json({ message: 'Grocery item deleted' });
        } else {
            res.status(404).json({ message: 'Grocery item not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete grocery item' });
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
