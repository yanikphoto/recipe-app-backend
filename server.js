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
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists on startup
if (!fsSync.existsSync(UPLOADS_DIR)) {
    fsSync.mkdirSync(UPLOADS_DIR);
}

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
            const initialData = { recipes: [], groceryList: [], deletedRecipeIds: [], deletedGroceryIds: [], images: {} };
            await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const fileContent = await fs.readFile(DATA_FILE, 'utf8');
        const data = JSON.parse(fileContent);
        // Ensure required objects/arrays exist
        data.deletedRecipeIds = data.deletedRecipeIds || [];
        data.deletedGroceryIds = data.deletedGroceryIds || [];
        data.images = data.images || {};
        return data;
    } catch (error) {
        console.error('Error reading data file, returning empty state:', error);
        return { recipes: [], groceryList: [], deletedRecipeIds: [], deletedGroceryIds: [], images: {} };
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

// Helper to get all image IDs currently available (from data.images or disk)
const getAvailableImageIds = (data) => {
    const idsFromData = Object.keys(data.images || {});
    let idsFromDisk = [];
    try {
        if (fsSync.existsSync(UPLOADS_DIR)) {
            const files = fsSync.readdirSync(UPLOADS_DIR);
            idsFromDisk = files
                .filter(f => !f.endsWith('.tmp'))
                .map(f => f.replace(/\.(jpg|jpeg|png|webp)$/i, ''));
        }
    } catch (e) {}
    return Array.from(new Set([...idsFromData, ...idsFromDisk]));
};

// Route for serving images with dynamic fallback from data.json base64 store
app.get('/uploads/:filename', async (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(UPLOADS_DIR, filename);
    
    // 1. Check if file exists on disk
    if (fsSync.existsSync(filePath)) {
        return res.sendFile(filePath);
    }

    // 2. Fallback: retrieve image base64 from data.json
    const imageId = filename.replace(/\.(jpg|jpeg|png|webp)$/i, '');
    const data = await readData();

    if (data.images && data.images[imageId]) {
        const base64Data = data.images[imageId];
        const imgBuffer = Buffer.from(base64Data, 'base64');

        // Write back to disk asynchronously for static serving
        try {
            await fs.writeFile(filePath, imgBuffer);
        } catch (e) {
            console.error('Failed to write back dynamic image:', e);
        }

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        return res.send(imgBuffer);
    }

    return res.status(404).json({ error: 'Image not found' });
});

// Also serve uploads statically as fallback
app.use('/uploads', express.static(UPLOADS_DIR));

const mergeOrderedList = (serverList, clientList) => {
    const safeClientList = (clientList || []).filter(i => i && typeof i === 'object' && i.id);
    const safeServerList = (serverList || []).filter(i => i && typeof i === 'object' && i.id);

    const allItemsMap = new Map();
    [...safeServerList, ...safeClientList].forEach(item => {
        const existing = allItemsMap.get(item.id);
        if (!existing) {
            allItemsMap.set(item.id, item);
        } else {
            const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
            const newTime = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
            if (newTime >= existingTime) {
                 if (item.instructions && !item.imageBase64 && existing.imageBase64) {
                    allItemsMap.set(item.id, { ...item, imageBase64: existing.imageBase64 });
                } else {
                    allItemsMap.set(item.id, item);
                }
            }
        }
    });

    const getListRecencyScore = (list) => {
        if (!list || list.length === 0) return 0;
        const timestamps = list.map(i => i.updatedAt ? new Date(i.updatedAt).getTime() : 0);
        const sortedTimestamps = timestamps.sort((a, b) => b - a);
        const medianIndex = Math.floor(sortedTimestamps.length / 2);
        return sortedTimestamps[medianIndex] || 0;
    };

    const clientScore = getListRecencyScore(safeClientList);
    const serverScore = getListRecencyScore(safeServerList);

    const authoritativeList = clientScore >= serverScore ? safeClientList : safeServerList;
    const otherList = clientScore >= serverScore ? safeServerList : safeClientList;
    
    const authoritativeIds = new Set(authoritativeList.map(i => i.id));
    
    let mergedList = authoritativeList.map(item => allItemsMap.get(item.id));

    otherList.forEach(item => {
        if (!authoritativeIds.has(item.id)) {
            mergedList.push(allItemsMap.get(item.id));
        }
    });
    
    return mergedList.filter(Boolean);
};

const mergeDeletedIds = (existingIds, newIds) => {
    const idSet = new Set([...(existingIds || []), ...(newIds || [])]);
    return Array.from(idSet);
};

// Routes
app.get('/', (req, res) => res.json({ message: 'Recipe App API is running!' }));
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.get('/data', async (req, res) => {
  try {
    const data = await readData();
    const availableImageIds = getAvailableImageIds(data);
    const { images, ...dataToSend } = data;
    res.json({ ...dataToSend, availableImageIds });
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
    if (!Array.isArray(clientData.recipes) || !Array.isArray(clientData.groceryList) || !Array.isArray(clientData.deletedRecipeIds) || !Array.isArray(clientData.deletedGroceryIds)) {
        return res.status(400).json({ error: 'Invalid data structure: missing required arrays' });
    }
    
    const serverData = await readData();
    const imagesStore = serverData.images || {};
    
    // 1. Merge deleted ID lists
    const allDeletedRecipeIds = mergeDeletedIds(serverData.deletedRecipeIds, clientData.deletedRecipeIds);
    const allDeletedGroceryIds = mergeDeletedIds(serverData.deletedGroceryIds, clientData.deletedGroceryIds);

    // 2. Merge main lists
    const mergedRecipes = mergeOrderedList(serverData.recipes, clientData.recipes);
    const mergedGrocery = mergeOrderedList(serverData.groceryList, clientData.groceryList);

    // 3. Filter using deleted IDs
    const finalRecipesRaw = mergedRecipes.filter(r => !allDeletedRecipeIds.includes(r.id));
    const finalGrocery = mergedGrocery.filter(i => !allDeletedGroceryIds.includes(i.id));

    // 4. Process images: save base64 data to imagesStore in data.json AND to disk
    const finalRecipes = await Promise.all(finalRecipesRaw.map(async (recipe) => {
        if (recipe.imageBase64 && recipe.imageUrl) {
            try {
                // Save to images object in data.json
                imagesStore[recipe.imageUrl] = recipe.imageBase64;

                // Also save file to disk
                const imagePath = path.join(UPLOADS_DIR, `${recipe.imageUrl}.jpg`);
                const tempPath = imagePath + '.tmp';
                await fs.writeFile(tempPath, recipe.imageBase64, { encoding: 'base64' });
                await fs.rename(tempPath, imagePath);
            } catch (e) {
                console.error(`Failed to save image for recipe ${recipe.id}:`, e);
            }
            const { imageBase64, ...recipeForStorage } = recipe;
            return recipeForStorage;
        }
        return recipe;
    }));

    // Clean up images for recipes that have been deleted
    const activeImageUrls = new Set(finalRecipes.map(r => r.imageUrl).filter(Boolean));
    for (const imgId in imagesStore) {
        if (!activeImageUrls.has(imgId)) {
            delete imagesStore[imgId];
            try {
                const diskPath = path.join(UPLOADS_DIR, `${imgId}.jpg`);
                if (fsSync.existsSync(diskPath)) {
                    await fs.unlink(diskPath);
                }
            } catch (e) {}
        }
    }

    const DELETED_ID_HISTORY_LIMIT = 1000;

    const finalDataToSave = {
      recipes: finalRecipes,
      groceryList: finalGrocery,
      images: imagesStore,
      lastUpdated: new Date().toISOString(),
      deletedRecipeIds: allDeletedRecipeIds.slice(-DELETED_ID_HISTORY_LIMIT),
      deletedGroceryIds: allDeletedGroceryIds.slice(-DELETED_ID_HISTORY_LIMIT),
    };
    
    if (await writeData(finalDataToSave)) {
      const availableImageIds = getAvailableImageIds(finalDataToSave);
      const finalDataToSend = {
          recipes: finalRecipes,
          groceryList: finalGrocery,
          lastUpdated: finalDataToSave.lastUpdated,
          deletedRecipeIds: finalDataToSave.deletedRecipeIds,
          deletedGroceryIds: finalDataToSave.deletedGroceryIds,
          availableImageIds,
      };
      res.status(200).json(finalDataToSend);
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