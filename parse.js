/* parse.js — turns an uploaded PDF into raw text, then into candidate transactions.
   Text-based PDFs go through pdf.js. Scanned pages fall back to on-device OCR (Tesseract). */
const Parse = (() => {

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const TESS_OPTS = {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
  };

  const INCOME_HINTS = /DEPOSIT|PAYROLL|SALARY|DIRECT\s*DEP|CREDIT\s*(?!CARD)|REFUND|REIMBURSEMENT|INTEREST\s*PAID|TRANSFER\s*IN|PAYMENT\s*RECEIVED/i;

  const DATE_RE = '(\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:,?\\s*\\d{2,4})?|\\d{1,2}\\s+[A-Za-z]{3,9}\\.?(?:\\s*\\d{2,4})?)';
  const AMOUNT_RE = '(\\(?-?\\$?\\d[\\d,]*\\.\\d{2}\\)?)\\s*(CR|DR)?';
  const LINE_RE = new RegExp('^\\s*' + DATE_RE + '\\s+(.+?)\\s+' + AMOUNT_RE + '\\s*$', 'i');

  function parseAmount(raw) {
    let s = raw.trim();
    let negative = false;
    if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1); }
    if (s.startsWith('-')) { negative = true; s = s.slice(1); }
    s = s.replace(/[$,]/g, '');
    const value = parseFloat(s);
    return { value: isNaN(value) ? null : value, negative };
  }

  function normalizeDate(raw, statementYearHint) {
    const s = raw.trim().replace(/,/g, '');
    // MM/DD/YYYY or MM-DD-YYYY or MM/DD
    let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
    if (m) {
      let [, a, b, y] = m;
      let year = y ? (y.length === 2 ? 2000 + parseInt(y) : parseInt(y)) : statementYearHint;
      let month = parseInt(a), day = parseInt(b);
      if (month > 12) { [month, day] = [day, month]; } // DD/MM fallback
      return isoDate(year, month, day);
    }
    // "Jan 5 2026" or "Jan 5"
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*(\d{2,4})?$/);
    if (m) {
      const mi = months.indexOf(m[1].slice(0,3).toLowerCase());
      if (mi >= 0) {
        const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : statementYearHint;
        return isoDate(year, mi + 1, parseInt(m[2]));
      }
    }
    // "5 Jan 2026"
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(\d{2,4})?$/);
    if (m) {
      const mi = months.indexOf(m[2].slice(0,3).toLowerCase());
      if (mi >= 0) {
        const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : statementYearHint;
        return isoDate(year, mi + 1, parseInt(m[1]));
      }
    }
    return null;
  }

  function isoDate(year, month, day) {
    if (!year || !month || !day) return null;
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  function extractCandidates(text) {
    const yearHint = new Date().getFullYear();
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (line.length < 6) continue;
      const m = line.match(LINE_RE);
      if (!m) continue;
      const [, dateRaw, descRaw, amountRaw, crdr] = m;
      const date = normalizeDate(dateRaw, yearHint);
      const { value, negative } = parseAmount(amountRaw);
      if (!date || value === null || value === 0) continue;
      let desc = descRaw.trim();
      if (desc.length < 2) continue;
      // skip obvious header/footer noise
      if (/^(balance|total|subtotal|page \d|statement period|summary)/i.test(desc)) continue;

      let isIncome = negative ? false : INCOME_HINTS.test(desc) || crdr === 'CR';
      if (crdr === 'DR') isIncome = false;
      if (negative) isIncome = false;

      out.push({ date, description: desc, amount: Math.abs(value), isIncome });
    }
    return out;
  }

  async function extractTextFromPdf(file, onStatus) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let fullText = '';
    let charCount = 0;
    const pageTexts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      onStatus && onStatus(`Reading page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(it => it.str).join('\n');
      pageTexts.push({ page, pageText });
      charCount += pageText.trim().length;
      fullText += pageText + '\n';
    }

    // Heuristic: if very little extractable text, this is likely a scanned PDF -> OCR fallback
    const avgCharsPerPage = charCount / pdf.numPages;
    if (avgCharsPerPage < 40) {
      fullText = '';
      for (let i = 0; i < pageTexts.length; i++) {
        onStatus && onStatus(`Running on-device OCR, page ${i + 1} of ${pageTexts.length}…`);
        const { page } = pageTexts[i];
        const viewport = page.getViewport({ scale: 2.2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        const ocrText = await ocrCanvas(canvas);
        fullText += ocrText + '\n';
      }
    }
    return fullText;
  }

  let ocrWorkerPromise = null;
  async function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = Tesseract.createWorker('eng', 1, TESS_OPTS);
    }
    return ocrWorkerPromise;
  }

  async function ocrCanvas(canvas) {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    return data.text || '';
  }

  async function parseStatement(file, onStatus) {
    const text = await extractTextFromPdf(file, onStatus);
    const candidates = extractCandidates(text);
    return candidates;
  }

  return { parseStatement, extractCandidates, normalizeDate, parseAmount };
})();
