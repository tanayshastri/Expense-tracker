/* categorize.js — default categories + keyword rules + learned merchant rules */
const Categorize = (() => {

  const DEFAULT_CATEGORIES = [
    { id: 'cat-income',      name: 'Income',        color: '#7A9B76' },
    { id: 'cat-groceries',   name: 'Groceries',     color: '#B98B4E' },
    { id: 'cat-dining',      name: 'Dining',        color: '#C1584A' },
    { id: 'cat-transport',   name: 'Transport',     color: '#6C8AA8' },
    { id: 'cat-housing',     name: 'Housing',       color: '#8E6B3C' },
    { id: 'cat-utilities',   name: 'Utilities',     color: '#7A8B8C' },
    { id: 'cat-subscriptions', name:'Subscriptions',color: '#9A6FA8' },
    { id: 'cat-shopping',    name: 'Shopping',      color: '#C77B9E' },
    { id: 'cat-health',      name: 'Health',        color: '#5E9C8F' },
    { id: 'cat-entertainment', name:'Entertainment',color: '#D0A24C' },
    { id: 'cat-travel',      name: 'Travel',        color: '#4E8FB9' },
    { id: 'cat-fees',        name: 'Fees & charges',color: '#A65D57' },
    { id: 'cat-other',       name: 'Other',         color: '#8A8A7C' },
  ];

  // keyword -> category id. Matched against uppercased description.
  const KEYWORD_RULES = [
    [/UBER\s*EATS|DOORDASH|GRUBHUB|POSTMATES|DELIVEROO|SWIGGY(?!\s*INSTAMART)|ZOMATO/, 'cat-dining'],
    [/STARBUCKS|COFFEE|CAFE|MCDONALD|CHIPOTLE|RESTAURANT|PIZZA|BAR\b|GRILL|BREW|WINES?\b/, 'cat-dining'],
    [/WHOLE\s*FOODS|TRADER\s*JOE|SAFEWAY|KROGER|GROCERY|SUPERMARKET|ALDI|COSTCO|WALMART\s*GROCERY|SWIGGY\s*INSTAMART|ZEPTO|BLINKIT|BIGBASKET|DMART|GROFERS/, 'cat-groceries'],
    [/UBER(?!\s*EATS)|LYFT|TAXI|TRANSIT|METRO|PARKING|SHELL|CHEVRON|EXXON|GAS\s*STATION|FUEL|OLA\b|RAPIDO|IRCTC|INDIAN\s*RAIL/, 'cat-transport'],
    [/RENT|MORTGAGE|LANDLORD|PROPERTY\s*MGMT|NOBROKER|HOUSING\.COM/, 'cat-housing'],
    [/ELECTRIC|WATER\s*CO|GAS\s*COMPANY|UTILITY|INTERNET|COMCAST|XFINITY|VERIZON|AT&T|T-MOBILE|AIRTEL|JIO\b|VODAFONE|BSNL|MMRDA|MOBIKWIK/, 'cat-utilities'],
    [/NETFLIX|SPOTIFY|HULU|DISNEY\+|APPLE\s*MEDIA|APPLE\.COM\/BILL|AMAZON\s*PRIME|YOUTUBE\s*PREMIUM|ICLOUD|SUBSCRIPTION|HOTSTAR|SONYLIV/, 'cat-subscriptions'],
    [/AMAZON(?!\s*PRIME)|TARGET|BEST\s*BUY|MACY|NORDSTROM|EBAY|ETSY|SHOPPING|MYNTRA|FLIPKART|AJIO|URBAN\s*COMPANY|ETHOS\s*WATCH/, 'cat-shopping'],
    [/PHARMACY|CVS|WALGREENS|DOCTOR|CLINIC|DENTAL|HOSPITAL|HEALTH|APOLLO|PINK\s*PHARMACY/, 'cat-health'],
    [/MOVIE|CINEMA|AMC|CONCERT|TICKETMASTER|STEAM|PLAYSTATION|XBOX|GAME\b|PVR|INOX|BOOKMYSHOW/, 'cat-entertainment'],
    [/AIRLINE|AIRLINES|HOTEL|AIRBNB|EXPEDIA|BOOKING\.COM|DELTA|UNITED\s*AIR|FLIGHT|MAKEMYTRIP|GOIBIBO|OYO/, 'cat-travel'],
    [/OVERDRAFT|LATE\s*FEE|SERVICE\s*CHARGE|ANNUAL\s*FEE|INTEREST\s*CHARGE|FOREIGN\s*TXN/, 'cat-fees'],
    [/GROWW|ZERODHA|UPSTOX|STOCKSIP|MUTUAL\s*FUND|SIP\b|COIN\b/, 'cat-other'],
    [/PAYROLL|SALARY|DIRECT\s*DEP|DEPOSIT\s*FROM|INTEREST\s*PAID|REFUND|REIMBURSEMENT|NEFT\s*CR|IB\s*FUNDS\s*TRANSFER\s*CR|ACH\s*C-/, 'cat-income'],
  ];

  function normalizeMerchant(desc) {
    return (desc || '')
      .toUpperCase()
      .replace(/[^A-Z0-9 &]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 3)
      .join(' ');
  }

  async function suggestCategory(description, isIncome) {
    const key = normalizeMerchant(description);
    const rule = await DB.get('rules', key);
    if (rule) return rule.categoryId;

    const upper = (description || '').toUpperCase();
    for (const [regex, catId] of KEYWORD_RULES) {
      if (regex.test(upper)) return catId;
    }
    return isIncome ? 'cat-income' : 'cat-other';
  }

  async function learn(description, categoryId) {
    const key = normalizeMerchant(description);
    if (!key) return;
    await DB.put('rules', { merchant: key, categoryId, updatedAt: Date.now() });
  }

  async function ensureDefaultCategories() {
    const existing = await DB.getAll('categories');
    if (existing.length) return existing;
    for (const c of DEFAULT_CATEGORIES) await DB.put('categories', c);
    return DEFAULT_CATEGORIES;
  }

  return { suggestCategory, learn, ensureDefaultCategories, normalizeMerchant, DEFAULT_CATEGORIES };
})();
