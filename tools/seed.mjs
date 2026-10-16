import products from "../src/seed-products.json" with { type: "json" };
import { token, passwordHash, uuid } from "../src/security.mjs";
export async function createUser(
  db,
  { email, name, password, owner = false, vendor_id, role = "ADMIN" },
) {
  if (password.length < 12)
    throw Error("Password must have at least 12 characters");
  const id = uuid(),
    salt = token(),
    hash = await passwordHash(password, salt);
  await db
    .prepare(
      "INSERT INTO users(id,email,name,hash,salt,owner) VALUES(?,?,?,?,?,?)",
    )
    .bind(id, email.toLowerCase(), name, hash, salt, owner ? 1 : 0)
    .run();
  if (vendor_id)
    await db
      .prepare("INSERT INTO memberships(user_id,vendor_id,role) VALUES(?,?,?)")
      .bind(id, vendor_id, role)
      .run();
  return id;
}
export async function seed(db) {
  const current = await db.prepare("SELECT id FROM cities LIMIT 1").first();
  if (current) return;
  const target = db,
    statements = [];
  db = {
    prepare(sql) {
      let statement = target.prepare(sql);
      return {
        bind(...values) {
          statement = statement.bind(...values);
          return this;
        },
        async run() {
          statements.push(statement);
        },
      };
    },
  };

  const cities = [
    ["tbilisi", { ru: "Тбилиси", ka: "თბილისი", en: "Tbilisi" }],
    ["akhalkalaki", { ru: "Ахалкалаки", ka: "ახალქალაქი", en: "Akhalkalaki" }],
  ];
  for (const [id, names] of cities)
    await db
      .prepare("INSERT INTO cities(id,names) VALUES(?,?)")
      .bind(id, JSON.stringify(names))
      .run();
  const shops = [
    {
      id: "sweet-house",
      city: "akhalkalaki",
      names: { ru: "Sweet House", ka: "Sweet House", en: "Sweet House" },
      description: {
        ru: "Знакомые десерты, торты и кофе. Демонстрационная кондитерская.",
        ka: "ნამცხვრები, ტორტები და ყავა. სადემონსტრაციო ვიტრინა.",
        en: "Cakes, pastries and coffee. Demonstration bakery.",
      },
    },
    {
      id: "cacao-atelier",
      city: "tbilisi",
      names: { ru: "Cacao Atelier", ka: "Cacao Atelier", en: "Cacao Atelier" },
      description: {
        ru: "Шоколадные истории и десерты к особому случаю. Тестовый продавец.",
        ka: "შოკოლადი და დესერტები. სატესტო გამყიდველი.",
        en: "Chocolate stories for special occasions. Test seller.",
      },
    },
    {
      id: "sweet-house-tbilisi",
      city: "tbilisi",
      names: {
        ru: "Sweet House · Тбилиси",
        ka: "Sweet House · თბილისი",
        en: "Sweet House · Tbilisi",
      },
      description: {
        ru: "Отдельная тестовая витрина со своими ценами и остатками.",
        ka: "ცალკე სატესტო ვიტრინა საკუთარი ფასებითა და მარაგით.",
        en: "Independent test storefront with its own prices and stock.",
      },
    },
  ];
  for (const [i, v] of shops.entries()) {
    await db
      .prepare(
        "INSERT INTO vendors(id,city_id,slug,names,description,active,demo,delivery_enabled,delivery_fee) VALUES(?,?,?,?,?,1,1,1,?)",
      )
      .bind(
        v.id,
        v.city,
        v.id,
        JSON.stringify(v.names),
        JSON.stringify(v.description),
        500 + i * 100,
      )
      .run();
    for (const p of products) {
      const options = ["kofe", "chai2"].includes(p.category)
        ? [
            {
              id: "large",
              names: { ru: "Большой объём", ka: "დიდი ზომა", en: "Large" },
              delta: 100,
            },
          ]
        : [];
      await db
        .prepare(
          "INSERT INTO products(id,vendor_id,source_id,names,description,category,image,price,stock,lead_minutes,options) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          v.id + "--" + p.id,
          v.id,
          p.id,
          JSON.stringify(p.names),
          JSON.stringify({
            ru: "Состав и аллергены уточняются у изготовителя. Демо-товар.",
            ka: "შემადგენლობა დაზუსტდება მწარმოებელთან. დემო პროდუქტი.",
            en: "Ingredients and allergens require seller confirmation. Demo product.",
          }),
          p.category,
          p.image,
          p.price + i * 50,
          30,
          p.lead_minutes,
          JSON.stringify(options),
        )
        .run();
    }
  }
  await target.batch(statements);
}
