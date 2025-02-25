import express from 'express';
import db from './database.js';
import { ingredientSynonyms, complexityMap, timeKeywords, fillerWords, categories } from './constants.js';

const router = express.Router();

// 🟢 Get All Recipes
router.get('/', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM recipes");
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching recipes:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// 🟢 Search Recipes Endpoint
router.get('/search', async (req, res) => {
  let { query } = req.query;
  if (!query) {
    return res.status(400).json({ message: "Search query required" });
  }

  // Clean up query: remove wrapping quotes and normalize.
  query = query.trim();
  if (query.startsWith('"') && query.endsWith('"')) {
    query = query.substring(1, query.length - 1).trim();
  }
  query = query.toLowerCase();

  // ===== 1. CATEGORY SEARCH =====
  if (categories.includes(query)) {
    try {
      const categoryResult = await db.query(
        "SELECT * FROM recipes WHERE LOWER(category) = $1",
        [query]
      );
      if (categoryResult.rows.length > 0) {
        return res.json({
          message: "Here are the best recipes for you",
          recipes: categoryResult.rows
        });
      }
    } catch (error) {
      console.error("Error fetching category recipes:", error);
      return res.status(500).json({ message: "Server error" });
    }
  }

  // ===== 2. RECIPE NAME SEARCH =====
  try {
    const nameResult = await db.query(
      "SELECT * FROM recipes WHERE LOWER(name) ILIKE $1",
      [`%${query}%`]
    );
    if (nameResult.rows.length > 0) {
      return res.json({
        message: "Here are the best recipes for you",
        recipes: nameResult.rows
      });
    }
  } catch (error) {
    console.error("Error fetching recipe by name:", error);
    // Proceed further if this search fails.
  }

  // ===== 3. NEGATIVE FILTERING FOR 'EGG' =====
  let excludeEgg = false;
  const negativeEggPattern = /\b(eggless|without egg|no egg|doesnt contain egg|doesn't contain egg)\b/gi;
  if (negativeEggPattern.test(query)) {
    excludeEgg = true;
    query = query.replace(negativeEggPattern, "").trim();
  }

  // ===== 4. REPLACE INGREDIENT SYNONYMS =====
  for (let key in ingredientSynonyms) {
    const regex = new RegExp(`\\b${key}\\b`, "gi");
    query = query.replace(regex, ingredientSynonyms[key]);
  }

  // ===== 5. EXTRACT FILTERS (COMPLEXITY & COOKING TIME) =====
  let extractedComplexity = null;
  let cookingTime = null;

  // Extract complexity if present
  for (const key in complexityMap) {
    const regex = new RegExp(`\\b${key}\\b`, "i");
    if (regex.test(query)) {
      extractedComplexity = complexityMap[key];
      query = query.replace(regex, "").trim();
      break;
    }
  }
  // Extract cooking time from time keywords
  for (const phrase in timeKeywords) {
    const regex = new RegExp(`\\b${phrase}\\b`, "i");
    if (regex.test(query)) {
      cookingTime = timeKeywords[phrase];
      query = query.replace(regex, "").trim();
      break;
    }
  }
  // If any standalone number exists and cookingTime is still null, use it.
  const numMatch = query.match(/\b\d+\b/);
  if (numMatch && cookingTime === null) {
    cookingTime = parseInt(numMatch[0]);
    query = query.replace(new RegExp(`\\b${numMatch[0]}\\b`, "i"), "").trim();
  }

  // ===== 6. REMOVE FILLER WORDS & PUNCTUATION =====
  fillerWords.forEach(word => {
    query = query.replace(new RegExp(`\\b${word}\\b`, "gi"), "").trim();
  });
  query = query.replace(/[.,?!]/g, " ").replace(/\s+/g, " ").trim();
  let ingredientQuery = query || null;

  // ===== 7. CONSTRUCT INGREDIENTS ARRAY =====
  let ingredientsArray = [];
  if (ingredientQuery) {
    if (ingredientQuery.includes(',')) {
      ingredientsArray = ingredientQuery.split(',')
        .map(item => item.trim())
        .filter(item => item && !fillerWords.includes(item.toLowerCase()));
    } else {
      ingredientsArray = ingredientQuery.split(/\s+/)
        .filter(item => item && !fillerWords.includes(item.toLowerCase()));
    }
  }

  // ===== 8. HANDLE CASE: NO INGREDIENTS BUT FILTERS EXIST =====
  if (ingredientsArray.length === 0 && (cookingTime !== null || extractedComplexity)) {
    let conditions = [];
    let values = [];
    let i = 1;
    if (cookingTime !== null) {
      conditions.push(`cooking_time <= $${i}`);
      values.push(cookingTime);
      i++;
    }
    if (extractedComplexity) {
      conditions.push(`LOWER(complexity) = $${i}`);
      values.push(extractedComplexity.toLowerCase());
      i++;
    }
    try {
      const filteredResult = await db.query(`SELECT * FROM recipes WHERE ${conditions.join(" AND ")}`, values);
      if (filteredResult.rows.length > 0) {
        return res.json({
          message: "Here are the best recipes for you",
          recipes: filteredResult.rows
        });
      }
    } catch (error) {
      console.error("Error fetching recipes by time/complexity:", error);
      return res.status(500).json({ message: "Server error" });
    }
  }

  // ===== 9. FALLBACK: NO INGREDIENTS & NO FILTERS =====
  if (ingredientsArray.length === 0) {
    try {
      const randomResult = await db.query("SELECT * FROM recipes ORDER BY RANDOM() LIMIT 18");
      return res.json({
        message: "We don't have recipes for those ingredients, but here are some of our best suggestions!",
        recipes: randomResult.rows
      });
    } catch (error) {
      console.error("Error fetching random recipes:", error);
      return res.status(500).json({ message: "Server error" });
    }
  }

  // ===== 10. SEARCH BY INGREDIENTS =====
  try {
    // --- Attempt an exact match for all ingredients ---
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
    let ingredientResult = await db.query(sqlAll, valuesAll);

    if (ingredientResult.rows.length > 0) {
      let ingredientRecipes = ingredientResult.rows;
      let finalResult = ingredientRecipes;
      let message = "Here are the best recipes for you";

      // --- Hierarchical Filtering ---
      if (extractedComplexity) {
        let complexityFiltered = ingredientRecipes.filter(recipe =>
          recipe.complexity.toLowerCase() === extractedComplexity.toLowerCase()
        );
        if (complexityFiltered.length > 0) {
          finalResult = complexityFiltered;
          message = "Here are the best recipes for you";
          if (cookingTime !== null) {
            let timeFiltered = complexityFiltered.filter(recipe =>
              recipe.cooking_time <= cookingTime
            );
            if (timeFiltered.length > 0) {
              finalResult = timeFiltered;
              message = "Here are the best recipes for you";
            } else {
              finalResult = complexityFiltered.sort((a, b) => a.cooking_time - b.cooking_time);
              message = "We couldn't find recipes matching your time requirement exactly, but here are some based on your ingredients and complexity.";
            }
          }
        } else {
          // No recipes match the complexity filter.
          if (cookingTime !== null) {
            let timeFiltered = ingredientRecipes.filter(recipe =>
              recipe.cooking_time <= cookingTime
            );
            if (timeFiltered.length > 0) {
              finalResult = timeFiltered;
              message = "We couldn't find recipes matching your complexity, but here are some matching your time requirement.";
            } else {
              finalResult = ingredientRecipes;
              message = "We couldn't find recipes matching your filters exactly, but here are some recipes based on your ingredients.";
            }
          } else {
            finalResult = ingredientRecipes;
            message = "We couldn't find recipes matching your complexity, but here are some recipes based on your ingredients.";
          }
        }
      } else if (cookingTime !== null) {
        let timeFiltered = ingredientRecipes.filter(recipe =>
          recipe.cooking_time <= cookingTime
        );
        if (timeFiltered.length > 0) {
          finalResult = timeFiltered;
          message = "Here are the best recipes for you";
        } else {
          finalResult = ingredientRecipes;
          message = "We couldn't find recipes matching your cooking time exactly, but here are some recipes based on your ingredients.";
        }
      }
      return res.json({
        message,
        recipes: finalResult
      });
    }

    // --- If no exact match, try combination queries ---
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
    let combinationMatches = [];
    if (combinationQueries.length > 0) {
      const combinationResults = await Promise.all(combinationQueries);
      combinationMatches = combinationResults.flatMap(result => result.rows);
    }
    if (combinationMatches.length > 0) {
      return res.json({
        message: "We don't have an exact match for all your ingredients, but here are some recipes based on some of your ingredients.",
        recipes: combinationMatches
      });
    }

    // --- If no combination match, try individual ingredient queries ---
    let singleQueries = ingredientsArray.map(ing => {
      let sql = "SELECT * FROM recipes WHERE ingredients ILIKE $1";
      if (excludeEgg) {
        sql += " AND ingredients NOT ILIKE '%egg%'";
      }
      return db.query(sql, [`%${ing}%`]);
    });
    const singleResults = await Promise.all(singleQueries);
    const individualMatches = singleResults.flatMap(result => result.rows);
    if (individualMatches.length > 0) {
      return res.json({
        message: "We couldn't find a recipe with all the ingredients, but here are some recipes using at least one of your ingredients.",
        recipes: individualMatches
      });
    }

    // --- Final fallback: return random recipes ---
    const randomResult = await db.query("SELECT * FROM recipes ORDER BY RANDOM() LIMIT 18");
    return res.json({
      message: "We don't have recipes for those ingredients, but here are some of our best suggestions!",
      recipes: randomResult.rows
    });
  } catch (error) {
    console.error("Error fetching recipes:", error);
    return res.status(500).json({ message: "Server error" });
  }
});




// 🟢 Save Search History
router.post('/save-search', async (req, res) => {
  const { user_id, recipe } = req.body;
  if (!user_id || !recipe) {
    return res.status(400).json({ message: "User ID and recipe object are required" });
  }

  try {
    const userExists = await db.query("SELECT id FROM users WHERE id = $1", [user_id]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    let userSearches = await db.query("SELECT search_history FROM users WHERE id = $1", [user_id]);
    let searches = userSearches.rows[0]?.search_history || [];
    if (typeof searches === "string") {
      try {
        searches = JSON.parse(searches);
      } catch (err) {
        searches = [];
      }
    }
    if (!Array.isArray(searches)) {
      searches = [];
    }

    // Check if the recipe already exists in the search history.
    const existingIndex = searches.findIndex((r) => r.id === recipe.id);
    if (existingIndex !== -1) {
      // Remove the recipe from its current position.
      searches.splice(existingIndex, 1);
    }

    // Add the recipe at the beginning.
    searches.unshift(recipe);
    if (searches.length > 4) {
      searches.pop();
    }

    await db.query("UPDATE users SET search_history = $1 WHERE id = $2", [JSON.stringify(searches), user_id]);
    res.json({ message: "Search history updated", searches });
  } catch (error) {
    console.error("Error saving search history:", error);
    res.status(500).json({ message: "Server error" });
  }
});


// GET Search History
router.get('/get-search-history', async (req, res) => {
  let { user_id } = req.query;
  if (!user_id) {
    return res.status(400).json({ message: "User ID is required" });
  }
  user_id = parseInt(user_id);
  if (isNaN(user_id)) {
    return res.status(400).json({ message: "Invalid user ID format" });
  }

  try {
    const userExists = await db.query("SELECT id FROM users WHERE id = $1", [user_id]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    let result = await db.query("SELECT search_history FROM users WHERE id = $1", [user_id]);
    let searchHistory = result.rows.length > 0 ? result.rows[0].search_history : [];
    if (typeof searchHistory === "string") {
      try {
        searchHistory = JSON.parse(searchHistory);
      } catch (error) {
        searchHistory = [];
      }
    }
    res.json({ user_id, search_history: searchHistory });
  } catch (error) {
    console.error("Error fetching search history:", error);
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
    // Verify user exists.
    const userExists = await db.query("SELECT id FROM users WHERE id = $1", [user_id]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    // Verify recipe exists.
    const recipeExists = await db.query("SELECT id FROM recipes WHERE id = $1", [recipe_id]);
    if (recipeExists.rows.length === 0) {
      return res.status(404).json({ message: "Recipe not found" });
    }
    
    // Check if the favorite already exists.
    const favoriteCheck = await db.query(
      "SELECT * FROM favorites WHERE user_id = $1 AND recipe_id = $2",
      [user_id, recipe_id]
    );
    
    if (favoriteCheck.rows.length > 0) {
      // If already favorited, remove it.
      await db.query(
        "DELETE FROM favorites WHERE user_id = $1 AND recipe_id = $2",
        [user_id, recipe_id]
      );
      return res.json({ message: "Recipe removed from favorites!" });
    } else {
      // Otherwise, add it to favorites.
      const result = await db.query(
        "INSERT INTO favorites (user_id, recipe_id) VALUES ($1, $2) RETURNING *",
        [user_id, recipe_id]
      );
      return res.json({ message: "Recipe saved to favorites!", favorite: result.rows[0] });
    }
    
  } catch (error) {
    console.error("Error toggling favorite:", error);
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
    console.error("Error removing favorite:", error);
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
  const { user_id, comment_text } = req.body;
  const recipe_id = req.params.id;
  if (!user_id || !comment_text) {
    return res.status(400).json({ message: "User ID and comment text are required" });
  }
  try {
    const result = await db.query(
      "INSERT INTO comments (user_id, recipe_id, comment_text) VALUES ($1, $2, $3) RETURNING *",
      [user_id, recipe_id, comment_text]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error adding comment:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET comments
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

// Edit comments
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

// Delete comments
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
  const { user_id, rating } = req.body;
  const recipe_id = req.params.id;
  if (!user_id || !rating) {
    return res.status(400).json({ message: "User ID and rating are required" });
  }
  try {
    await db.query(
      "INSERT INTO ratings (user_id, recipe_id, rating) VALUES ($1, $2, $3) ON CONFLICT (user_id, recipe_id) DO UPDATE SET rating = EXCLUDED.rating",
      [user_id, recipe_id, rating]
    );
    res.json({ message: "Rating submitted successfully" });
  } catch (error) {
    console.error("Error submitting rating:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Average rating
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
