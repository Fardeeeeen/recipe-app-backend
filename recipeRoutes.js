import express from 'express';
import db from './database.js';
import { ingredientSynonyms, complexityMap, timeKeywords, fillerWords } from './constants.js';

const router = express.Router();
console.log("🔍 Recipe Routes Loaded");

// 🟢 Get All Recipes
router.get('/', async (req, res) => {
    console.log(" GET /api/recipes request received");
    try {
        const result = await db.query("SELECT * FROM recipes");
        res.json(result.rows);
    } catch (error) {
        console.error("❌ Error fetching recipes:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// 🟢 Search Recipes
router.get('/search', async (req, res) => {
  let { query } = req.query;
  console.log("query --> ", query);
  if (!query) {
    return res.status(400).json({ message: "Search query required" });
  }

  // Remove extra wrapping quotes if present.
  query = query.trim();
  if (query.startsWith('"') && query.endsWith('"')) {
    query = query.substring(1, query.length - 1);
  }

  // Normalize query.
  query = query.toLowerCase().trim();
  console.log("🔍 Received search query:", query);

  // --- Negative Filtering for Egg ---
  let excludeEgg = false;
  const negativeEggPattern = /\b(eggless|without egg|no egg|doesnt contain egg|doesn't contain egg)\b/gi;
  if (negativeEggPattern.test(query)) {
    excludeEgg = true;
    query = query.replace(negativeEggPattern, "").trim();
    //console.log("🔍 Excluding recipes that contain eggs");
  }

  // Replace ingredient synonyms.
  for (let key in ingredientSynonyms) {
    const regex = new RegExp(`\\b${key}\\b`, "gi");
    query = query.replace(regex, ingredientSynonyms[key]);
  }

  // --- Extraction Process ---
  let extractedComplexity = null;
  let cookingTime = null;

  // Extract complexity.
  for (const key in complexityMap) {
    if (new RegExp(`\\b${key}\\b`, "i").test(query)) {
      extractedComplexity = complexityMap[key];
      query = query.replace(new RegExp(`\\b${key}\\b`, "i"), "").trim();
      break;
    }
  }

  // Extract cooking time from known phrases.
  for (const phrase in timeKeywords) {
    if (new RegExp(`\\b${phrase}\\b`, "i").test(query)) {
      cookingTime = timeKeywords[phrase];
      query = query.replace(new RegExp(`\\b${phrase}\\b`, "i"), "").trim();
      break;
    }
  }

  // Look for direct numbers if no time phrase found.
  const numMatch = query.match(/\b\d+\b/);
  if (numMatch && cookingTime === null) {
    cookingTime = parseInt(numMatch[0]);
    query = query.replace(new RegExp(`\\b${numMatch[0]}\\b`, "i"), "").trim();
  }

  // Remove filler words.
  fillerWords.forEach(word => {
    query = query.replace(new RegExp(`\\b${word}\\b`, "gi"), "").trim();
  });

  // Remove punctuation (note: this regex doesn't remove quotes).
  query = query.replace(/[.,?!]/g, " ").replace(/\s+/g, " ").trim();

  let ingredientQuery = query || null;

 // --- Handling Multiple Ingredients ---
 let ingredientsArray = [];
 if (ingredientQuery) {
   if (ingredientQuery.includes(',')) {
     ingredientsArray = ingredientQuery.split(',')
       .map(item => item.trim())
       // Remove any filler words that might have slipped through
       .filter(item => item && !fillerWords.includes(item.toLowerCase()));
   } else {
     ingredientsArray = ingredientQuery.split(/\s+/)
       .filter(item => item && !fillerWords.includes(item.toLowerCase()));
   }
 }

// Check if there are no ingredients after processing
if (ingredientsArray.length === 0) {
  try {
    const randomResult = await db.query("SELECT * FROM recipes ORDER BY RANDOM() LIMIT 18");
    return res.json({
      message: "No ingredients provided, showing random recipes instead.",
      recipes: randomResult.rows
    });
  } catch (error) {
    console.error("❌ Error fetching random recipes:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

try {
  // Try exact match (all ingredients together)
  let sqlAll = "SELECT * FROM recipes WHERE ";
  let valuesAll = [];
  ingredientsArray.forEach((ing, index) => {
    if (index > 0) sqlAll += " AND ";
    sqlAll += `ingredients ILIKE $${index + 1}`;
    valuesAll.push(`%${ing}%`);
  });
  
  if (excludeEgg) {
    sqlAll += " AND ingredients NOT ILIKE '%egg%'";
  }
  //console.log("🔍 SQL Query (Exact Match):", sqlAll, valuesAll);
  let ingredientResult = await db.query(sqlAll, valuesAll);

  // Check combinations of ingredients if no exact match
  if (ingredientResult.rows.length === 0) {
    // finding recipes with at least two matching ingredients together
    let combinationQueries = [];
    for (let i = 0; i < ingredientsArray.length; i++) {
      for (let j = i + 1; j < ingredientsArray.length; j++) {
        let sqlPair = "SELECT * FROM recipes WHERE ingredients ILIKE $1 AND ingredients ILIKE $2";
        let valuesPair = [`%${ingredientsArray[i]}%`, `%${ingredientsArray[j]}%`];
        if (excludeEgg) {
          sqlPair += " AND ingredients NOT ILIKE '%egg%'";
        }
        combinationQueries.push(db.query(sqlPair, valuesPair));
      }
    }
    
    // Execute all two-ingredient queries in parallel
    let combinationResults = await Promise.all(combinationQueries);
    let combinationMatches = combinationResults.flatMap(result => result.rows);
    
    // If combinations found, return those results
    if (combinationMatches.length > 0) {
      return res.json({
        message: "No exact match found for all ingredients, but recipes with some combinations exist.",
        partialSolution: "Here are recipes that match combinations of your requested ingredients:",
        recipes: combinationMatches
      });
    }
    
    console.log("⚠️ No combinations found. Proceeding to individual ingredient searches...");
    
    // Fetching individual ingredient matches
    let singleQueries = ingredientsArray.map(ing => {
      let sql = "SELECT * FROM recipes WHERE ingredients ILIKE $1";
      if (excludeEgg) {
        sql += " AND ingredients NOT ILIKE '%egg%'";
      }
      return db.query(sql, [`%${ing}%`]);
    });
    
    // Execute all individual ingredient queries in parallel
    let singleResults = await Promise.all(singleQueries);
    let individualMatches = singleResults.flatMap(result => result.rows);
    
    // If individual matches found, return those results
    if (individualMatches.length > 0) {
      return res.json({
        message: "No exact match found for the combination of ingredients.",
        partialSolution: "Here are some recipes that match individual ingredients:",
        recipes: individualMatches
      });
    }
    
    // If no matches at all, query random recipes instead of returning an empty list
    try {
      const randomResult = await db.query("SELECT * FROM recipes ORDER BY RANDOM() LIMIT 18");
      return res.json({
        message: "No recipes found for the given ingredients, showing random recipes instead.",
        recipes: randomResult.rows
      });
    } catch (error) {
      console.error("❌ Error fetching random recipes:", error);
      return res.status(500).json({ message: "Server error" });
    }
  }
  
  console.log("✅ Found recipes with ingredient(s):", ingredientResult.rows.length);
  
  // Hierarchical Search: Filter recipes based on complexity and cooking time
  let finalResult = [];
  let complexityFiltered = [];
  let timeFiltered = [];
  let ingredientOnlyFiltered = [];
  let output = {};
  
  const ingredientRecipes = ingredientResult.rows;
  
  // Filter by complexity
  if (extractedComplexity) {
    complexityFiltered = ingredientRecipes.filter(recipe =>
      recipe.complexity.toLowerCase() === extractedComplexity
    );
    if (complexityFiltered.length > 0) {
      if (cookingTime !== null) {
        timeFiltered = complexityFiltered.filter(recipe =>
          recipe.cooking_time <= cookingTime
        );
        if (timeFiltered.length > 0) {
          finalResult = timeFiltered;
          output = {
            message: "Exact match found: ingredient, complexity, and cooking time.",
            recipes: finalResult
          };
          return res.json(output);
        } else {
          finalResult = complexityFiltered.sort((a, b) => a.cooking_time - b.cooking_time);
          output = {
            message: "Alternative solution: ingredient and complexity matched, but cooking time did not exactly match.",
            recipes: finalResult
          };
          return res.json(output);
        }
      } else {
        finalResult = complexityFiltered;
        output = {
          message: "Match found based on ingredient and complexity.",
          recipes: finalResult
        };
        return res.json(output);
      }
    } else {
      // If no complexity match, try cooking time only.
      if (cookingTime !== null) {
        timeFiltered = ingredientRecipes.filter(recipe =>
          recipe.cooking_time <= cookingTime
        );
        if (timeFiltered.length > 0) {
          finalResult = timeFiltered;
          output = {
            message: "Alternative solution: ingredient and cooking time match (no complexity match).",
            recipes: finalResult
          };
          return res.json(output);
        }
      }
      ingredientOnlyFiltered = ingredientRecipes;
      output = {
        message: "Match found based on ingredient only (no complexity or cooking time match).",
        recipes: ingredientOnlyFiltered
      };
      return res.json(output);
    }
  } else {
    // No complexity filter provided.
    if (cookingTime !== null) {
      timeFiltered = ingredientRecipes.filter(recipe =>
        recipe.cooking_time <= cookingTime
      );
      if (timeFiltered.length > 0) {
        finalResult = timeFiltered;
        output = {
          message: "Match found based on ingredient and cooking time.",
          recipes: finalResult
        };
        return res.json(output);
      } else {
        ingredientOnlyFiltered = ingredientRecipes;
        output = {
          message: "Match found based on ingredient only (cooking time did not match).",
          recipes: ingredientOnlyFiltered
        };
        return res.json(output);
      }
    }
    ingredientOnlyFiltered = ingredientRecipes;
    output = {
      message: "Match found based on ingredient only.",
      recipes: ingredientOnlyFiltered
    };
    return res.json(output);
  }
  
} catch (error) {
  console.error("❌ Error fetching recipes:", error);
  return res.status(500).json({ message: "Server error" });
}
});


// 🟢 Save Search History
router.post('/save-search', async (req, res) => {
  const { user_id, recipe } = req.body;
  console.log("Save search history request:", req.body);
  
  if (!user_id || !recipe) {
    return res.status(400).json({ message: "User ID and recipe object are required" });
  }

  try {
    // Check if user exists first
    const userExists = await db.query("SELECT id FROM users WHERE id = $1", [user_id]);
    if (userExists.rows.length === 0) {
      console.log("User not found for user_id:", user_id);
      return res.status(404).json({ message: "User not found" });
    }

    // Fetch current search history
    let userSearches = await db.query("SELECT search_history FROM users WHERE id = $1", [user_id]);
    let searches = userSearches.rows[0]?.search_history || [];
    console.log("Raw search history from DB:", searches);
    
    // If stored as a string, parse it
    if (typeof searches === "string") {
      try {
        searches = JSON.parse(searches);
        console.log("Parsed search history:", searches);
      } catch (err) {
        console.error("Error parsing existing search history:", err);
        searches = [];
      }
    }
    
    if (!Array.isArray(searches)) {
      searches = [];
    }
    
    // Add the new recipe object and limit to the last 3 entries
    searches.push(recipe);
    if (searches.length > 3) {
      searches.shift();
    }
    console.log("🔍 Updated Search History:", searches);
    
    // Update the user record with the new search history (as JSON string)
    await db.query("UPDATE users SET search_history = $1 WHERE id = $2", [JSON.stringify(searches), user_id]);
    
    res.json({ message: "Search history updated", searches });
  } catch (error) {
    console.error("❌ Error saving search history:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET Search History
router.get('/get-search-history', async (req, res) => {
  let { user_id } = req.query;
  console.log("GET search history called with user_id:", user_id);
  
  if (!user_id) {
    return res.status(400).json({ message: "User ID is required" });
  }
  
  user_id = parseInt(user_id);
  if (isNaN(user_id)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    // Check if the user exists
    const userExists = await db.query("SELECT id FROM users WHERE id = $1", [user_id]);
    if (userExists.rows.length === 0) {
      console.log("User not found for user_id:", user_id);
      return res.status(404).json({ message: "User not found" });
    }

    let result = await db.query("SELECT search_history FROM users WHERE id = $1", [user_id]);
    let searchHistory = result.rows.length > 0 ? result.rows[0].search_history : [];
    
    // If stored as a string, parse it
    if (typeof searchHistory === "string") {
      try {
        searchHistory = JSON.parse(searchHistory);
      } catch (error) {
        console.error("Error parsing search history:", error);
        searchHistory = [];
      }
    }
    
    console.log("Fetched search history for user_id:", user_id, ":", searchHistory);
    res.json({ user_id, search_history: searchHistory });
  } catch (error) {
    console.error("❌ Error fetching search history:", error);
    res.status(500).json({ message: "Server error" });
  }
});


// 🟢 Save Favorite Recipe
router.post('/save-favorite', async (req, res) => {
  const { user_id, recipe_id } = req.body;

  if (!user_id || !recipe_id) {
      return res.status(400).json({ message: "User ID and Recipe ID are required" });
  }

  try {
      // ✅ Check if user exists
      const userExists = await db.query("SELECT id FROM users WHERE id = $1", [user_id]);
      if (userExists.rows.length === 0) {
          return res.status(404).json({ message: "User not found" });
      }

      // ✅ Check if recipe exists before favoriting
      const recipeExists = await db.query("SELECT id FROM recipes WHERE id = $1", [recipe_id]);
      if (recipeExists.rows.length === 0) {
          return res.status(404).json({ message: "Recipe not found" });
      }

      // ✅ Insert into favorites table
      const result = await db.query(
          "INSERT INTO favorites (user_id, recipe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *",
          [user_id, recipe_id]
      );

      if (result.rowCount === 0) {
          return res.status(400).json({ message: "Recipe already favorited" });
      }

      res.json({ message: "Recipe saved to favorites!" });
  } catch (error) {
      console.error("❌ Error saving favorite:", error);
      res.status(500).json({ message: "Server error" });
  }
});


// 🟢 Get User's Favorite Recipes
router.get('/favorites/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
      const result = await db.query(
          "SELECT recipes.* FROM recipes JOIN favorites ON recipes.id = favorites.recipe_id WHERE favorites.user_id = $1",
          [user_id]
      );
      res.json(result.rows);
  } catch (error) {
      console.error("Error fetching favorites:", error);
      res.status(500).json({ message: "Server error" });
  }
});

// 🟢 Remove Favorite Recipe
router.post('/remove-favorite', async (req, res) => {
  const { user_id, recipe_id } = req.body;

  if (!user_id || !recipe_id) {
      return res.status(400).json({ message: "User ID and Recipe ID are required" });
  }

  try {
      const result = await db.query(
          "DELETE FROM favorites WHERE user_id = $1 AND recipe_id = $2 RETURNING *",
          [user_id, recipe_id]
      );

      if (result.rowCount === 0) {
          return res.status(404).json({ message: "Recipe not found in favorites" });
      }

      res.json({ message: "Recipe removed from favorites!" });
  } catch (error) {
      console.error("❌ Error removing favorite:", error);
      res.status(500).json({ message: "Server error" });
  }
});

// 🟢 Get Recipe by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
      const result = await db.query("SELECT * FROM recipes WHERE id = $1", [id]);
      if (result.rows.length === 0) {
          return res.status(404).json({ message: "Recipe not found" });
      }
      res.json(result.rows[0]);
  } catch (error) {
      console.error("Error fetching recipe:", error);
      res.status(500).json({ message: "Server error" });
  }
});

// POST comment
router.post('/:id/comment', async (req, res) => {
  console.log("Comment request body:", req.body);
  const { user_id, comment_text } = req.body;
  const recipe_id = req.params.id;
  if (!user_id || !comment_text) {
      console.log("Missing user_id or comment_text");
      return res.status(400).json({ message: "User ID and comment text are required" });
  }
  try {
      console.log(`Inserting comment for recipe ${recipe_id} by user ${user_id}`);
      const result = await db.query(
          "INSERT INTO comments (user_id, recipe_id, comment_text) VALUES ($1, $2, $3) RETURNING *",
          [user_id, recipe_id, comment_text]
      );
      console.log("Comment inserted:", result.rows[0]);
      res.json(result.rows[0]);
  } catch (error) {
      console.error("Error adding comment:", error);
      res.status(500).json({ message: "Server error" });
  }
});

//get comments
router.get('/:id/comments', async (req, res) => {
  const recipe_id = req.params.id;

  try {
      const result = await db.query(
          "SELECT comments.*, users.username FROM comments JOIN users ON comments.user_id = users.id WHERE recipe_id = $1 ORDER BY created_at DESC",
          [recipe_id]
      );
      res.json(result.rows);
  } catch (error) {
      console.error("Error fetching comments:", error);
      res.status(500).json({ message: "Server error" });
  }
});

// edit comments
router.put('/comments/:comment_id', async (req, res) => {
  const { user_id, comment_text } = req.body;
  const comment_id = req.params.comment_id;

  try {
      const result = await db.query(
          "UPDATE comments SET comment_text = $1 WHERE id = $2 AND user_id = $3 RETURNING *",
          [comment_text, comment_id, user_id]
      );

      if (result.rowCount === 0) {
          return res.status(403).json({ message: "Not authorized to edit this comment" });
      }

      res.json({ message: "Comment updated successfully" });
  } catch (error) {
      console.error("Error updating comment:", error);
      res.status(500).json({ message: "Server error" });
  }
});


// delete comments
router.delete('/comments/:comment_id', async (req, res) => {
  const { user_id } = req.body;
  const comment_id = req.params.comment_id;

  try {
      const result = await db.query(
          "DELETE FROM comments WHERE id = $1 AND user_id = $2 RETURNING *",
          [comment_id, user_id]
      );

      if (result.rowCount === 0) {
          return res.status(403).json({ message: "Not authorized to delete this comment" });
      }

      res.json({ message: "Comment deleted successfully" });
  } catch (error) {
      console.error("Error deleting comment:", error);
      res.status(500).json({ message: "Server error" });
  }
});

// POST rating
router.post('/:id/rate', async (req, res) => {
  console.log("Rating request body:", req.body);
  const { user_id, rating } = req.body;
  const recipe_id = req.params.id;
  if (!user_id || !rating) {
      console.log("Missing user_id or rating");
      return res.status(400).json({ message: "User ID and rating are required" });
  }
  try {
      console.log(`Inserting rating for recipe ${recipe_id} by user ${user_id} with rating ${rating}`);
      await db.query(
          "INSERT INTO ratings (user_id, recipe_id, rating) VALUES ($1, $2, $3) ON CONFLICT (user_id, recipe_id) DO UPDATE SET rating = EXCLUDED.rating",
          [user_id, recipe_id, rating]
      );
      console.log("Rating inserted/updated successfully");
      res.json({ message: "Rating submitted successfully" });
  } catch (error) {
      console.error("Error submitting rating:", error);
      res.status(500).json({ message: "Server error" });
  }
});


//average rating
router.get('/:id/ratings', async (req, res) => {
  const recipe_id = req.params.id;

  try {
      const result = await db.query(
          "SELECT ROUND(AVG(rating), 1) AS average_rating FROM ratings WHERE recipe_id = $1",
          [recipe_id]
      );

      res.json({ average_rating: result.rows[0].average_rating || 0 });
  } catch (error) {
      console.error("Error fetching ratings:", error);
      res.status(500).json({ message: "Server error" });
  }
});







export default router;