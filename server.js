const express = require('express');
const cors = require('cors');
const fs = require('fs').promises; // Use the promises version of fs for async operations
const fsSync = require('fs'); // For one-time sync check on startup
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
// Use the default cors() configuration which is permissive and robust for development and most use cases.
// It defaults to origin: '*' and handles pre-flight OPTIONS requests automatically.
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DATA_FILE = path.join(__dirname, 'data.json');

// --- Simple Async Lock to prevent race conditions ---
let isLocked = false;
const withLock = async (fn) => {
    while (isLocked) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    isLocked = true;
    try {
        return await fn();
    } finally {
        isLocked = false;
    }
};
// --- End of Lock ---

const readData = () => withLock(async () => {
    try {
        if (!fsSync.existsSync(DATA_FILE)) {
            const initialData = { recipes: [], groceryList: [], deletedRecipeIds: [], deletedGroceryIds: [] };
            await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const fileContent = await fs.readFile(DATA_FILE, 'utf8');
        const data = JSON.parse(fileContent);
        // Ensure the deleted ID arrays exist for backward compatibility
        data.deletedRecipeIds = data.deletedRecipeIds || [];
        data.deletedGroceryIds = data.deletedGroceryIds || [];
        return data;
    } catch (error) {
        console.error('Error reading data file, returning empty state:', error);
        return { recipes: [], groceryList: [], deletedRecipeIds: [], deletedGroceryIds: [] };
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
  (existingRecipes || []).filter(r => r && typeof r === 'object' && r.id).forEach(recipe => recipeMap.set(recipe.id, recipe));
  (newRecipes || []).filter(r => r && typeof r === 'object' && r.id).forEach(recipe => recipeMap.set(recipe.id, recipe));
  return Array.from(recipeMap.values());
};

// HARDENED: Merge grocery items properly, filtering out invalid entries.
const mergeGroceryList = (existingItems, newItems) => {
  const itemMap = new Map();
  (existingItems || []).filter(i => i && typeof i === 'object' && i.id).forEach(item => itemMap.set(item.id, item));
  (newItems || []).filter(i => i && typeof i === 'object' && i.id).forEach(item => itemMap.set(item.id, item));
  return Array.from(itemMap.values());
};

// Routes - now all async
app.get('/', (req, res) => res.json({ message: 'Recipe App API is running!' }));
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.get('/data', async (req, res) => {
  try {
    const data = await readData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read data' });
  }
});

app.post('/data', async (req, res) => {
  try {
    const newData = req.body;
    if (!newData || typeof newData !== 'object' || !Array.isArray(newData.recipes) || !Array.isArray(newData.groceryList)) {
      return res.status(400).json({ error: 'Invalid data structure' });
    }
    
    const existingData = await readData();
    
    // Before merging, filter out any items from the incoming data that are on the server's deleted list.
    const cleanNewRecipes = (newData.recipes || []).filter(r => !(existingData.deletedRecipeIds || []).includes(r.id));
    const cleanNewGrocery = (newData.groceryList || []).filter(i => !(existingData.deletedGroceryIds || []).includes(i.id));

    const mergedData = {
      recipes: mergeRecipes(existingData.recipes, cleanNewRecipes),
      groceryList: mergeGroceryList(existingData.groceryList, cleanNewGrocery),
      lastUpdated: new Date().toISOString(),
      deletedRecipeIds: existingData.deletedRecipeIds,
      deletedGroceryIds: existingData.deletedGroceryIds,
    };
    
    if (await writeData(mergedData)) {
      res.status(200).json(mergedData);
    } else {
      res.status(500).json({ error: 'Failed to save data' });
    }
  } catch (error) {
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

app.post('/recipes', async (req, res) => {
  try {
    const newRecipe = req.body;
    if (!newRecipe || !newRecipe.id || !newRecipe.title) {
      return res.status(400).json({ error: 'Invalid recipe data' });
    }
    
    const data = await readData();
    // If we're adding/updating, it's not deleted. Remove from deleted list.
    data.deletedRecipeIds = data.deletedRecipeIds.filter(id => id !== newRecipe.id);
    
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

app.delete('/recipes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await readData();
        const initialLength = data.recipes.length;
        data.recipes = data.recipes.filter(r => r.id !== id);
        // Add to deleted IDs list to prevent re-sync from stale clients
        if (!data.deletedRecipeIds.includes(id)) {
            data.deletedRecipeIds.push(id);
        }
        await writeData(data);
        res.status(200).json({ message: 'Recipe deletion confirmed' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete recipe' });
    }
});

app.post('/grocery', async (req, res) => {
    try {
        const newItem = req.body;
        if (!newItem || !newItem.id || !newItem.name) {
            return res.status(400).json({ error: 'Invalid grocery item' });
        }
        const data = await readData();
        // If we're adding/updating, it's not deleted.
        data.deletedGroceryIds = data.deletedGroceryIds.filter(id => id !== newItem.id);

        if (!data.groceryList.some(i => i.id === newItem.id)) {
            data.groceryList.unshift(newItem);
            await writeData(data);
        }
        res.status(200).json(newItem);
    } catch (error) {
        res.status(500).json({ error: 'Failed to save grocery item' });
    }
});

app.delete('/grocery/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = await readData();
        data.groceryList = data.groceryList.filter(i => i.id !== id);
        // Add to deleted IDs list
        if (!data.deletedGroceryIds.includes(id)) {
            data.deletedGroceryIds.push(id);
        }
        await writeData(data);
        res.status(200).json({ message: 'Grocery item deletion confirmed' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete grocery item' });
    }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});