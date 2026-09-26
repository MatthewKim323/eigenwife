/**
 * The Act III restaurant page. Menya Tsuki is fictional (a Mensho-style
 * Tokyo ramen spot invented for the demo). Prices are deliberately spicy:
 * the $21 garlic bowl and the $28 premium bowl are the demo's "this".
 */

export interface Dish {
  id: string;
  name: string;
  jp: string;
  price: number;
  /** 0..5 chilies. */
  spice: number;
  rating: number;
  reviews: number;
  blurb: string;
  tags: string[];
  img: string;
  /** Generative-art fallback hue when the image is missing. */
  hue: number;
}

export const RESTAURANT = {
  name: "Menya Tsuki",
  kana: "麺屋 月",
  tagline: "Tokyo-style ramen, slow broth, late nights",
  address: "1841 Valencia St, San Francisco (fictional)",
  url: "https://menyatsuki.example/menu",
  rating: 4.6,
  reviews: 2_314,
  hours: "Open until 11:30 PM",
  priceLevel: "$$$",
} as const;

export const MENU: Dish[] = [
  {
    id: "garlic-knockout",
    name: "Garlic Knockout Ramen",
    jp: "にんにくノックアウト",
    price: 21,
    spice: 2,
    rating: 4.6,
    reviews: 812,
    blurb: "Double tonkotsu, 40 cloves of black garlic oil, chashu, ajitama. Not first-date safe.",
    tags: ["signature", "rich"],
    img: "/menu/garlic-knockout.webp",
    hue: 60,
  },
  {
    id: "a5-wagyu",
    name: "A5 Wagyu Shoyu",
    jp: "A5和牛醤油",
    price: 28,
    spice: 0,
    rating: 4.8,
    reviews: 341,
    blurb: "Clear shoyu broth, seared A5 wagyu, truffle-yuzu kosho, hand-cut noodles. The flex bowl.",
    tags: ["premium", "limited"],
    img: "/menu/a5-wagyu.webp",
    hue: 30,
  },
  {
    id: "tantanmen",
    name: "Hellfire Tantanmen",
    jp: "地獄担々麺",
    price: 19,
    spice: 5,
    rating: 4.7,
    reviews: 1_024,
    blurb: "Sesame chili broth, numbing sansho, spicy pork, bok choy. Tissues provided.",
    tags: ["spicy", "popular"],
    img: "/menu/tantanmen.webp",
    hue: 20,
  },
  {
    id: "yuzu-shio",
    name: "Yuzu Shio",
    jp: "柚子塩",
    price: 17,
    spice: 0,
    rating: 4.5,
    reviews: 603,
    blurb: "Light chicken and sea salt broth, yuzu peel, chicken chashu, mizuna. Bright, clean, polite.",
    tags: ["light"],
    img: "/menu/yuzu-shio.webp",
    hue: 95,
  },
  {
    id: "miso-veggie",
    name: "Spicy Miso Vegan",
    jp: "辛味噌ベジ",
    price: 18,
    spice: 3,
    rating: 4.4,
    reviews: 288,
    blurb: "Red miso and soy milk broth, charred corn, tofu, chili threads. Fully plant-based.",
    tags: ["vegan", "spicy"],
    img: "/menu/miso-veggie.webp",
    hue: 45,
  },
  {
    id: "karaage",
    name: "Black Garlic Karaage",
    jp: "黒にんにく唐揚げ",
    price: 12,
    spice: 1,
    rating: 4.6,
    reviews: 955,
    blurb: "Crispy thigh, black garlic glaze, shichimi mayo. Five pieces, zero regrets.",
    tags: ["side"],
    img: "/menu/karaage.webp",
    hue: 35,
  },
];
