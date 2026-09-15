/**
 * שולף הכנסות והוצאות ממאנדיי ומחזיר אותן מנורמלות.
 *
 * הפונקציה לא מסכמת ולא מסננת — היא מסמנת. הסכימה והסינון נעשים
 * בצד הלקוח כדי שהמתגים בדשבורד יעבדו בלי סיבוב נוסף לשרת,
 * ובהיקף הזה (כ-120 רשומות) זה זול מכל חלופה.
 */

/**
 * ההכנסה נמדדת בלוח הלידים ולא בלוח ההכנסות: העסקה נספרת ביום
 * שנסגרה ובמחיר שסוכם בפועל אחרי ההנחה, ולא ביום שהכסף נרשם.
 * רק לידים בסטטוס «נסגר בהצלחה» נספרים.
 */
const BOARD_INCOME = 5026766166;
const BOARD_EXPENSES = 5031295733;

const INCOME_STATUS = 'נסגר בהצלחה';

const COL_INCOME_STATUS = 'color_mm0ts2n0';   // סטטוס מכירה
const COL_INCOME_DATE   = 'date_mm2ses3r';    // תאריך סגירה
const COL_INCOME_AMOUNT = 'numeric_mm25qqb5'; // מחיר לאחר הנחה

const COL_EXPENSE_DATE   = 'date_mm3b5ymm';
const COL_EXPENSE_AMOUNT = 'numeric_mm3b6268';
const COL_VENDOR         = 'text_mm76b0zx';

const MONDAY_URL = 'https://api.monday.com/v2';

const QUERY = `
  query Finance($incomeBoard: [ID!], $expenseBoard: [ID!], $limit: Int!) {
    income: boards(ids: $incomeBoard) {
      items_page(limit: $limit) {
        cursor
        items {
          id
          name
          column_values(ids: ["${COL_INCOME_DATE}", "${COL_INCOME_AMOUNT}", "${COL_INCOME_STATUS}"]) { id text }
        }
      }
    }
    expenses: boards(ids: $expenseBoard) {
      items_page(limit: $limit) {
        cursor
        items {
          id
          name
          column_values(ids: ["${COL_EXPENSE_DATE}", "${COL_EXPENSE_AMOUNT}", "${COL_VENDOR}"]) { id text }
        }
      }
    }
  }
`;

const NEXT_PAGE = `
  query NextPage($cursor: String!, $limit: Int!) {
    next_items_page(cursor: $cursor, limit: $limit) {
      cursor
      items {
        id
        name
        column_values { id text }
      }
    }
  }
`;

async function callMonday(token, query, variables) {
  const response = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  // מאנדיי מחזיר 200 גם על שגיאות GraphQL — הסטטוס לבדו אינו מספיק
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(e => e.message).join('; '));
  }
  if (!response.ok) {
    throw new Error(`מאנדיי החזיר ${response.status}`);
  }
  return payload.data;
}

const cellText = (item, columnId) =>
  item.column_values?.find(c => c.id === columnId)?.text ?? null;

/** סכום ריק אינו אפס — רשומה בלי סכום נספרת כחסרה ולא כ-0 */
function parseAmount(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const value = Number(String(raw).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * קבלה על חשבונית שכבר רשומה היא אותה הוצאה פעמיים.
 * הסימון כאן בלבד — ההחלטה אם לספור נשארת בדשבורד.
 */
const isReceipt = (name) => /קבלה/.test(name || '');

/** רשומות שסומנו ידנית לבדיקה במאנדיי */
const needsReview = (name) => /⚠|לבדיקה/.test(name || '');

async function drainPages(token, firstPage, limit) {
  const items = [...(firstPage?.items ?? [])];
  let cursor = firstPage?.cursor ?? null;

  while (cursor) {
    const data = await callMonday(token, NEXT_PAGE, { cursor, limit });
    const page = data.next_items_page;
    items.push(...(page?.items ?? []));
    cursor = page?.cursor ?? null;
  }
  return items;
}

module.exports = async (req, res) => {
  const token = process.env.MONDAY_API_KEY;

  if (!token) {
    res.status(500).json({
      error: 'MONDAY_API_KEY לא מוגדר',
      hint: 'יש להוסיף את המשתנה תחת Settings → Environment Variables בוורסל, ואז Redeploy.',
    });
    return;
  }

  try {
    const limit = 500;
    const data = await callMonday(token, QUERY, {
      incomeBoard: [String(BOARD_INCOME)],
      expenseBoard: [String(BOARD_EXPENSES)],
      limit,
    });

    const incomeItems = await drainPages(token, data.income?.[0]?.items_page, limit);
    const expenseItems = await drainPages(token, data.expenses?.[0]?.items_page, limit);

    // ליד שלא נסגר אינו הכנסה — הוא מסונן כאן ולא מגיע לדשבורד כלל
    const income = incomeItems
      .filter(item => cellText(item, COL_INCOME_STATUS) === INCOME_STATUS)
      .map(item => ({
        id: item.id,
        name: item.name,
        date: cellText(item, COL_INCOME_DATE),
        amount: parseAmount(cellText(item, COL_INCOME_AMOUNT)),
        status: cellText(item, COL_INCOME_STATUS),
      }));

    const expenses = expenseItems.map(item => ({
      id: item.id,
      name: item.name,
      date: cellText(item, COL_EXPENSE_DATE),
      amount: parseAmount(cellText(item, COL_EXPENSE_AMOUNT)),
      vendor: cellText(item, COL_VENDOR),
      isReceipt: isReceipt(item.name),
      needsReview: needsReview(item.name),
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      boards: {
        income: { id: String(BOARD_INCOME), name: 'לידים', filter: INCOME_STATUS },
        expenses: { id: String(BOARD_EXPENSES), name: 'הוצאות' },
      },
      income,
      expenses,
    });
  } catch (error) {
    res.status(502).json({ error: 'שליפה ממאנדיי נכשלה', detail: String(error.message || error) });
  }
};
