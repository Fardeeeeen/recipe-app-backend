import express from 'express';
import db from './database.js';
import { ingredientSynonyms, complexityMap, timeKeywords, fillerWords } from './constants.js';

const router = express.Router();
console.log("🔍 Recipe Routes Loaded");

// 🟢 Get All Recipes
router.get('/', async (req, res) => {
    console.log("🔍 GET /api/recipes request received");
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
    ingredientsArray = ingredientQuery.split(',').map(item => item.trim()).filter(item => item);
  } else {
    ingredientsArray = ingredientQuery.split(/\s+/).filter(item => item);
  }
}
console.log("🔍 Ingredients Array:", ingredientsArray);

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
  //console.log("⚠️ No exact recipes found for the combination of ingredients.");

  // finding recipes with at least two matching ingredients together
  let combinationQueries = [];
  for (let i = 0; i < ingredientsArray.length; i++) {
    for (let j = i + 1; j < ingredientsArray.length; j++) {
      let sqlPair = "SELECT * FROM recipes WHERE ingredients ILIKE $1 AND ingredients ILIKE $2";
      let valuesPair = [`%${ingredientsArray[i]}%`, `%${ingredientsArray[j]}%`];
      if (excludeEgg) {
        sqlPair += " AND ingredients NOT ILIKE '%egg%'";
      }
      //console.log("🔍 SQL Query (Pair):", sqlPair, valuesPair);
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

  // fetching individual ingredient matches
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

  // If no matches at all, return a final fallback message
  return res.json({
    message: "No recipes found for the given ingredients, either individually or in combination.",
    recipes: []
  });
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
  const { user_id, search_query } = req.body;

  try {
      // Fetch current search history
      let userSearches = await db.query(
          "SELECT search_history FROM users WHERE id = $1",
          [user_id]
      );

      let searches = userSearches.rows[0]?.search_history || [];

      if (!Array.isArray(searches)) {
          searches = [];
      }

      // Keep only the last 3 searches
      searches.push(search_query);
      if (searches.length > 3) {
          searches.shift();
      }

      console.log("🔍 Updated Search History:", searches); // Debugging log

      // Run the UPDATE query and log affected rows
      const updateResult = await db.query(
          "UPDATE users SET search_history = $1 WHERE id = $2 RETURNING *",
          [JSON.stringify(searches), user_id]
      );

      console.log("✅ UPDATE Query Result:", updateResult.rows); // Debugging log

      res.json({ message: "Search history updated", searches });
  } catch (error) {
      console.error("❌ Error saving search history:", error);
      res.status(500).json({ message: "Server error" });
  }
});

//getting search history
router.get('/get-search-history', async (req, res) => {
  let { user_id } = req.query;

  console.log("User ID from query:", user_id); // Log the user_id passed in the request

  if (!user_id) {
      return res.status(400).json({ message: "User ID is required" });
  }

  user_id = parseInt(user_id); // Convert to an integer

  if (isNaN(user_id)) {
      return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
      let result = await db.query(
          "SELECT search_history FROM users WHERE id = $1",
          [user_id]
      );

      console.log("Database result:", result.rows); // Log the result of the query

      if (result.rows.length === 0) {
          return res.status(404).json({ message: "User not found" });
      }

      res.json({ user_id, search_history: result.rows[0].search_history });
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
        const result = await db.query(
            "UPDATE recipes SET is_favorite = TRUE, user_id = $1 WHERE id = $2 RETURNING *",
            [user_id, recipe_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Recipe not found or already favorited" });
        }

        console.log("✅ Updated Favorite Recipe:", result.rows[0]); 
        res.json({ message: "Recipe saved to favorites!", updatedRecipe: result.rows[0] });
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
        // Check if the recipe is actually favorited
        const checkFavorite = await db.query(
            "SELECT * FROM recipes WHERE user_id = $1 AND id = $2 AND is_favorite = TRUE",
            [user_id, recipe_id]
        );

        if (checkFavorite.rows.length === 0) {
            return res.status(404).json({ message: "Recipe not found in favorites" });
        }

        // Update the recipe to remove it from favorites
        const result = await db.query(
            "UPDATE recipes SET is_favorite = FALSE WHERE user_id = $1 AND id = $2 RETURNING *",
            [user_id, recipe_id]
        );

        //console.log("✅ Removed Favorite Recipe:", result.rows[0]); 
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

export default router;