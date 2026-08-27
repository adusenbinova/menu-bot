/**
 * Добавление списка покупок в корзину arbuz.kz.
 *
 * ВАЖНО: этот скрипт нужно выполнять В КОНТЕКСТЕ ОТКРЫТОЙ ВКЛАДКИ arbuz.kz
 * (через javascript_tool / Claude in Chrome), а не как отдельный внешний
 * HTTP-запрос. Причина: API arbuz.kz привязан к HttpOnly-сессионной куке,
 * которая невидима и недоступна извне браузера — попытка обратиться к API
 * напрямую (curl/requests) возвращает 401 Unauthorized. Внутри страницы
 * fetch() автоматически прикладывает эту куку, и запросы проходят.
 *
 * Предусловие: в текущей сессии уже подтверждён адрес доставки (город +
 * улица/дом через обычный UI) — без этого поиск/корзина недоступны.
 *
 * Использование (в консоли/через javascript_tool на странице arbuz.kz):
 *   const items = [...]; // items из output/shopping_list_<date>.json
 *   const report = await addShoppingListToCart(items);
 *   console.log(JSON.stringify(report));
 *
 * Скрипт НИКОГДА не вызывает оформление/оплату заказа — только поиск
 * и добавление в корзину (PUT /api/v1/cart/add).
 */

// ВАЖНО: поле product.weight на arbuz.kz — это НЕ физический вес упаковки,
// а описание единицы продажи (почти всегда "1 шт", даже для пачки 2 кг муки).
// Реальный вес/объём упаковки зашит в свободном тексте названия товара,
// обычно в конце (например: "Мука Makfa ... 2 кг", "Сыр ... тёртый, 80 г").
// Берём ПОСЛЕДНЕЕ совпадение число+единица в названии.
function parsePackGramsFromName(name) {
  if (!name) return null;
  // Внимание: \b в JS не распознаёт кириллицу как "словесный" символ,
  // поэтому используем отрицательный lookahead вместо \b после единицы.
  const matches = [...String(name).matchAll(/([\d]+(?:[.,]\d+)?)\s*(кг|г|мл|л)(?![а-яё])/gi)];
  if (matches.length === 0) return null;
  const [, rawValue, rawUnit] = matches[matches.length - 1];
  const value = parseFloat(rawValue.replace(",", "."));
  const unit = rawUnit.toLowerCase();
  if (unit === "кг" || unit === "л") return value * 1000;
  return value; // г, мл
}

// Стоп-слова: если они встречаются в названии товара, это почти наверняка
// не то, что нужно (например, поиск "рис" находит корм для животных "с рисом").
const BLACKLIST_TOKENS = ["корм", "собак", "кошек", "для животных", "туалет", "подгуз", "игрушка", "лоток"];

// Ручные подсказки для ингредиентов, где название в recipes.json содержит
// скобки/слэш ("куриное филе (грудка)", "тортильи/лепёшки") — обычная
// токенизация "все слова обязательны" на них ломается: реальные товары
// на arbuz.kz называются то "Филе...", то "Грудка...", а не тем и другим
// сразу. query — что искать, required — какие стемы обязательны в
// названии товара (пустой список — не проверять, доверять поиску сайта).
const INGREDIENT_HINTS = {
  "батон/хлеб для панировки": { query: "белый хлеб", required: ["хлеб"] },
  "говядина (мякоть)": { query: "говядина мякоть", required: ["говяд"] },
  "говядина (стейк)": { query: "говядина стейк", required: ["говяд"] },
  "зелень (укроп/петрушка)": { query: "укроп", required: ["укроп"] },
  "укроп/петрушка": { query: "укроп", required: ["укроп"] },
  "йогурт натуральный (маринад)": { query: "йогурт натуральный", required: ["йогурт"] },
  "йогурт натуральный (основа соуса)": { query: "йогурт натуральный", required: ["йогурт"] },
  "картофель (для запечённых долек)": { query: "картофель", required: ["картоф"] },
  "куриное филе (бедро/грудка)": { query: "куриное филе", required: ["курин"] },
  "куриное филе (грудка)": { query: "куриная грудка", required: ["курин"] },
  "паста (макароны)": { query: "макароны", required: ["макарон"] },
  "сыр твёрдый (ломтики)": { query: "сыр ломтики", required: ["сыр"] },
  "сыр твёрдый (тёртый)": { query: "сыр тёртый", required: ["сыр"] },
  "тортильи/лепёшки": { query: "тортильи", required: [] },
  "фарш говядина+индейка": { query: "фарш говядина индейка", required: ["фарш"] },
  // Собственное название рецепта не совпадает с ассортиментом магазина:
  // "ягоды замороженные" ничего не находит буквально, но есть ягодная смесь.
  "ягоды замороженные": { query: "ягодная смесь замороженная", required: ["ягод"] },
  // arbuz.kz не продаёт целые консервированные томаты под этим названием —
  // ближайший реальный аналог для соуса/рагу.
  "томаты консервированные": { query: "помидоры консервированные", required: ["помидор"] },
};

function normalize(s) {
  return String(s).toLowerCase().replace(/ё/g, "е");
}

function tokenize(query) {
  return normalize(query)
    .split(/[^a-zа-я0-9]+/i)
    .filter((t) => t.length >= 3);
}

// Морфологическое совпадение "на глаз": обрезаем токен запроса до основы
// (без окончания), чтобы "индейки" совпало с "индейка" в названии товара
// ("яйцо" им.п. / "яйца" мн.ч. — тот же случай для коротких слов).
function stem(token) {
  if (token.length >= 6) return token.slice(0, token.length - 2);
  if (token.length >= 4) return token.slice(0, token.length - 1);
  return token;
}

function isGoodMatch(ingredientName, candidate, requiredStems) {
  const candName = normalize(candidate.name);
  if (BLACKLIST_TOKENS.some((bad) => candName.includes(bad))) return false;
  if (requiredStems.length === 0) return true;
  return requiredStems.every((s) => candName.includes(s));
}

function resolveSearch(ingredientName) {
  const hint = INGREDIENT_HINTS[ingredientName];
  if (hint) return { query: hint.query, requiredStems: hint.required };
  return { query: ingredientName, requiredStems: tokenize(ingredientName).map(stem) };
}

// Товар сам может быть упаковкой из нескольких штук ("...в лотке 30 шт"),
// а не одной штукой — иначе "нужно 4 яйца" превращается в заказ 4 лотков.
function parseCountPerPackFromName(name) {
  const m = String(name).match(/(\d+)\s*шт(?![а-яё])/i);
  return m ? parseInt(m[1], 10) : 1;
}

function computeQuantity(requestedQty, requestedUnit, product) {
  if (requestedUnit === "шт") {
    if (product.measure === "шт" && !product.isWeighted) {
      const countPerPack = parseCountPerPackFromName(product.name);
      const packs = Math.max(1, Math.ceil(parseFloat(requestedQty) / countPerPack));
      return countPerPack > 1
        ? { quantity: packs, note: `упаковка по ${countPerPack} шт — заказано ${packs} уп.` }
        : { quantity: packs };
    }
    // товар продаётся на вес, а рецепту нужно count штук — не угадываем вес,
    // берём минимальный шаг заказа и просим проверить вручную.
    return {
      quantity: product.quantityMinStep || 1,
      note: "товар продаётся на вес, не поштучно — проверьте количество вручную",
    };
  }

  const requestedGrams = parseFloat(requestedQty);

  // Товар продаётся вразвес напрямую в кг/л (бананы, овощи и т.п.) —
  // quantity в API означает количество кг/л, а не число упаковок.
  if ((product.measure === "кг" || product.measure === "л") && product.isWeighted) {
    const step = 0.1;
    const quantity = Math.max(step, Math.ceil(requestedGrams / 1000 / step) * step);
    return { quantity: Math.round(quantity * 10) / 10 };
  }

  const packGrams = parsePackGramsFromName(product.name);
  if (!packGrams) {
    return { quantity: 1, note: "не удалось определить вес упаковки по названию — проверьте количество вручную" };
  }
  const quantity = Math.max(1, Math.ceil(requestedGrams / packGrams));
  return { quantity };
}

async function searchProduct(name) {
  // limit=15: поиск arbuz.kz не всегда ранжирует точное совпадение первым
  // (например, "сметана" в топ-5 выдаёт только молоко/творог, сама сметана
  // появляется на 9-11 месте) — берём более широкий пул кандидатов и уже
  // среди них фильтруем через isGoodMatch.
  const url = "/api/v1/shop/search/products?" +
    new URLSearchParams({ "where[name][c]": name, page: 1, limit: 15 });
  const res = await fetch(url);
  if (!res.ok) throw new Error("search HTTP " + res.status);
  const json = await res.json();
  return json.data || [];
}

async function addToCart(productId, quantity) {
  const res = await fetch("/api/v1/cart/add", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: productId, quantity }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("cart/add HTTP " + res.status + ": " + text);
  }
  return res.json();
}

async function addShoppingListToCart(items, delayMs = 300) {
  const matched = [];
  const notFound = [];

  for (const item of items) {
    const { query, requiredStems } = resolveSearch(item.name);
    let candidates = [];
    try {
      candidates = await searchProduct(query);
    } catch (e) {
      notFound.push({ ...item, reason: "search_error: " + e.message });
      continue;
    }

    const best = candidates.find((c) => c.isAvailable && isGoodMatch(item.name, c, requiredStems));
    if (!best) {
      notFound.push({ ...item, reason: "not_available_or_not_found" });
      continue;
    }

    const qtyResult = computeQuantity(item.qty, item.unit, best);
    const quantity = typeof qtyResult === "number" ? qtyResult : qtyResult.quantity;

    try {
      await addToCart(best.id, quantity);
      matched.push({
        requested_name: item.name,
        requested_qty: item.qty,
        requested_unit: item.unit,
        matched_name: best.name,
        product_id: best.id,
        pack_grams: parsePackGramsFromName(best.name),
        quantity_added: quantity,
        price_per_pack: best.priceActual,
        total_price: best.priceActual * quantity,
        url: "https://arbuz.kz" + best.uri,
        note: qtyResult.note,
      });
    } catch (e) {
      notFound.push({ ...item, reason: "add_to_cart_error: " + e.message });
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  const totalCost = matched.reduce((sum, m) => sum + m.total_price, 0);
  return { matched, notFound, totalCost, matchedCount: matched.length, notFoundCount: notFound.length };
}
