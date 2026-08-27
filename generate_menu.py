#!/usr/bin/env python3
"""Генератор еженедельного меню ужинов и списка покупок.

Использование:
    python3 generate_menu.py [--date YYYY-MM-DD] [--avoid-weeks N] [--seed-note TEXT]

Логика:
- читает recipes.json (база рецептов) и history.json (история прошлых недель)
- исключает рецепты, использованные в последние N недель (по умолчанию 4)
- гарантирует минимум одно "интерактивное" блюдо для готовки с детьми
- считает белок на порцию и долю суточной нормы (69-90 г)
- строит список покупок на семью (2 взрослых + 2 ребёнка), сгруппированный по отделам
- сохраняет результат в history.json и печатает markdown-документ в output/
"""
import argparse
import json
import random
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
RECIPES_PATH = BASE_DIR / "recipes.json"
HISTORY_PATH = BASE_DIR / "history.json"
OUTPUT_DIR = BASE_DIR / "output"

DEPARTMENT_ORDER = [
    "мясо/птица",
    "молочные и яйца",
    "крупы и бакалея",
    "овощи и зелень",
    "консервы",
    "соусы и специи",
    "хлеб и выпечка",
    "заморозка",
]

DAILY_PROTEIN_LOW = 69
DAILY_PROTEIN_HIGH = 90
LOW_PROTEIN_THRESHOLD = 28  # ниже этого — предлагаем белковую добавку (F2.3)
WEEKDAY_LABELS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница"]


def load_json(path, default):
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def recently_used_ids(history, avoid_weeks):
    used = set()
    for week in history.get("weeks", [])[-avoid_weeks:]:
        used.update(week.get("recipe_ids", []))
    return used


def pick_menu(recipes, history, avoid_weeks, rng):
    avoid = recently_used_ids(history, avoid_weeks)
    pool = [r for r in recipes if r["id"] not in avoid]

    # Если пул слишком мал (история исчерпала варианты) — постепенно ослабляем ограничение,
    # начиная с самых давних недель, чтобы не остаться без блюд.
    weeks = history.get("weeks", [])
    relax = avoid_weeks
    while len(pool) < 5 and relax > 0:
        relax -= 1
        avoid = recently_used_ids(history, relax)
        pool = [r for r in recipes if r["id"] not in avoid]
    if len(pool) < 5:
        pool = list(recipes)

    rng.shuffle(pool)

    selected = []
    used_protein_sources = []

    def protein_source_penalty(r):
        return used_protein_sources.count(r["protein_source"])

    # 1) гарантируем минимум одно интерактивное блюдо для готовки с детьми
    interactive_candidates = [r for r in pool if r.get("interactive_for_kids")]
    if interactive_candidates:
        interactive_candidates.sort(key=protein_source_penalty)
        chosen = interactive_candidates[0]
        selected.append(chosen)
        used_protein_sources.append(chosen["protein_source"])
        pool.remove(chosen)

    # 2) добираем оставшиеся блюда, отдавая приоритет разнообразию источников белка
    while len(selected) < 5 and pool:
        pool.sort(key=protein_source_penalty)
        chosen = pool[0]
        selected.append(chosen)
        used_protein_sources.append(chosen["protein_source"])
        pool.remove(chosen)

    rng.shuffle(selected)
    return selected


def protein_share_str(protein_g):
    low_pct = round(protein_g / DAILY_PROTEIN_HIGH * 100)
    high_pct = round(protein_g / DAILY_PROTEIN_LOW * 100)
    return f"{low_pct}–{high_pct}% суточной нормы белка (69–90 г)"


def build_shopping_list(selected_recipes, family_equivalent_portions):
    agg = {}  # (name, unit, department) -> qty
    for recipe in selected_recipes:
        for ing in recipe["ingredients"]:
            key = (ing["name"], ing["unit"], ing["department"])
            qty = ing["qty"] * family_equivalent_portions
            agg[key] = agg.get(key, 0) + qty

    by_department = {}
    for (name, unit, department), qty in agg.items():
        if unit == "шт":
            qty_display = str(int(qty) if qty == int(qty) else round(qty + 0.5))
        else:
            qty_display = f"{qty:.0f}" if qty >= 10 else f"{qty:.1f}"
        by_department.setdefault(department, []).append((name, qty_display, unit))

    for department in by_department:
        by_department[department].sort(key=lambda x: x[0])

    return by_department


def render_markdown(week_start, selected_recipes, by_department, family):
    lines = []
    lines.append(f"# Меню недели ({week_start.strftime('%d.%m.%Y')} — {(week_start + timedelta(days=4)).strftime('%d.%m.%Y')})")
    lines.append("")
    lines.append(f"Семья: {family['adults']} взрослых + {family['kids']} детей-школьников. Ужины на 5 будних дней.")
    lines.append("")
    lines.append("## Меню и рецепты")
    lines.append("")

    for i, recipe in enumerate(selected_recipes):
        day_label = WEEKDAY_LABELS[i] if i < len(WEEKDAY_LABELS) else f"День {i+1}"
        protein_g = recipe["protein_g_per_adult_portion"]
        lines.append(f"### {day_label}: {recipe['name']}")
        badges = []
        if recipe.get("interactive_for_kids"):
            badges.append("👧👦 готовим вместе с детьми")
        if recipe.get("spicy"):
            badges.append("🌶 есть острый вариант — детская порция без специй")
        if badges:
            lines.append("*" + " · ".join(badges) + "*")
        lines.append("")
        lines.append(f"- Белок на взрослую порцию: **{protein_g} г** ({protein_share_str(protein_g)})")
        if protein_g < LOW_PROTEIN_THRESHOLD:
            lines.append("- ⚠️ Белка в этом ужине немного меньше обычного — рекомендуем добавить 100 г творога или греческого йогурта (+15–18 г белка) в качестве гарнира/дипа.")
        if recipe.get("kid_variant_note"):
            lines.append(f"- Детский вариант: {recipe['kid_variant_note']}")
        lines.append("")
        lines.append("Ингредиенты (на 1 взрослую порцию):")
        for ing in recipe["ingredients"]:
            lines.append(f"  - {ing['name']} — {ing['qty']} {ing['unit']}")
        lines.append("")
        lines.append("Приготовление:")
        for step in recipe["instructions"]:
            lines.append(f"  {step}")
        lines.append("")

    lines.append("## Список покупок")
    lines.append("")
    lines.append("*Количества рассчитаны на всю семью (2 взрослых + 2 ребёнка) на все 5 ужинов.*")
    lines.append("")
    for department in DEPARTMENT_ORDER:
        if department not in by_department:
            continue
        lines.append(f"### {department.capitalize()}")
        for name, qty_display, unit in by_department[department]:
            lines.append(f"- [ ] {name} — {qty_display} {unit}")
        lines.append("")

    remaining = set(by_department) - set(DEPARTMENT_ORDER)
    for department in sorted(remaining):
        lines.append(f"### {department.capitalize()}")
        for name, qty_display, unit in by_department[department]:
            lines.append(f"- [ ] {name} — {qty_display} {unit}")
        lines.append("")

    lines.append("---")
    lines.append(f"*Сформировано автоматически {date.today().strftime('%d.%m.%Y')}. "
                  "Список покупок передаётся в корзину arbuz.kz для оформления заказа пользователем. "
                  "Ни один заказ не подтверждается и не оплачивается автоматически.*")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", type=str, default=None, help="Дата начала недели (YYYY-MM-DD), по умолчанию — сегодня")
    parser.add_argument("--avoid-weeks", type=int, default=4, help="Не повторять блюда из последних N недель")
    args = parser.parse_args()

    week_start = date.fromisoformat(args.date) if args.date else date.today()

    data = load_json(RECIPES_PATH, {"recipes": [], "assumptions": {}})
    recipes = data["recipes"]
    assumptions = data.get("assumptions", {})
    family = assumptions.get("family", {"adults": 2, "kids": 2})
    family_equivalent_portions = assumptions.get("family_equivalent_portions", 3.2)

    history = load_json(HISTORY_PATH, {"weeks": []})

    rng = random.Random(week_start.isoformat())
    selected = pick_menu(recipes, history, args.avoid_weeks, rng)

    if len(selected) < 5:
        raise SystemExit(f"Недостаточно рецептов в базе: нужно 5, доступно {len(selected)}. Пополните recipes.json.")

    by_department = build_shopping_list(selected, family_equivalent_portions)
    doc = render_markdown(week_start, selected, by_department, family)

    OUTPUT_DIR.mkdir(exist_ok=True)
    out_path = OUTPUT_DIR / f"menu_{week_start.isoformat()}.md"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(doc)

    shopping_list_flat = [
        {"name": name, "qty": qty_display, "unit": unit, "department": department}
        for department, items in by_department.items()
        for name, qty_display, unit in items
    ]
    shopping_list_path = OUTPUT_DIR / f"shopping_list_{week_start.isoformat()}.json"
    save_json(shopping_list_path, {
        "week_start": week_start.isoformat(),
        "items": shopping_list_flat,
    })

    history.setdefault("weeks", []).append({
        "week_start": week_start.isoformat(),
        "recipe_ids": [r["id"] for r in selected],
    })
    save_json(HISTORY_PATH, history)

    print(f"OK: меню сохранено в {out_path}")
    print(f"OK: список покупок сохранён в {shopping_list_path}")
    print(f"Рецепты недели: {', '.join(r['name'] for r in selected)}")


if __name__ == "__main__":
    main()
