const express = require('express');
const cors = require('cors');
const fs = require('fs').promises; // Use the promises version of fs for async operations
const fsSync = require('fs'); // For one-time sync check on startup
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
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

const mergeDeletedIds = (existingIds, newIds) => {
    const idSet = new Set([...(existingIds || []), ...(newIds || [])]);
    return Array.from(idSet);
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
    const clientData = req.body;
    if (!clientData || typeof clientData !== 'object') {
      return res.status(400).json({ error: 'Invalid data structure: body is missing or not an object' });
    }
     // Add more specific validation
    if (!Array.isArray(clientData.recipes) || !Array.isArray(clientData.groceryList) || !Array.isArray(clientData.deletedRecipeIds) || !Array.isArray(clientData.deletedGroceryIds)) {
        return res.status(400).json({ error: 'Invalid data structure: missing required arrays' });
    }
    
    const serverData = await readData();
    
    // 1. Merge the lists of deleted IDs first to get a complete set of all deletions.
    const allDeletedRecipeIds = mergeDeletedIds(serverData.deletedRecipeIds, clientData.deletedRecipeIds);
    const allDeletedGroceryIds = mergeDeletedIds(serverData.deletedGroceryIds, clientData.deletedGroceryIds);

    // 2. Merge the main data lists from server and client.
    const mergedRecipes = mergeRecipes(serverData.recipes, clientData.recipes);
    const mergedGrocery = mergeGroceryList(serverData.groceryList, clientData.groceryList);

    // 3. Filter the merged lists using the complete set of deleted IDs.
    const finalRecipes = mergedRecipes.filter(r => !allDeletedRecipeIds.includes(r.id));
    const finalGrocery = mergedGrocery.filter(i => !allDeletedGroceryIds.includes(i.id));

    const finalData = {
      recipes: finalRecipes,
      groceryList: finalGrocery,
      lastUpdated: new Date().toISOString(),
      deletedRecipeIds: allDeletedRecipeIds,
      deletedGroceryIds: allDeletedGroceryIds,
    };
    
    if (await writeData(finalData)) {
      res.status(200).json(finalData);
    } else {
      res.status(500).json({ error: 'Failed to save data' });
    }
  } catch (error) {
    console.error('Error in /data POST endpoint:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});


app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});