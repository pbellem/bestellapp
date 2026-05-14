/**
 * Popup Restaurant — Printserver
 * 
 * Pollt Firebase voor nieuwe orders en stuurt tickets naar ESC/POS netwerkprinters.
 * Met retry-queue, printstatus in Firebase, en safe-failure: orders worden pas
 * gemarkeerd als verwerkt nadat alle printers succesvol gedrukt hebben.
 *
 * Installatie:
 *   npm install node-thermal-printer axios
 *
 * Configuratie:
 *   Pas FIREBASE_URL aan onderaan.
 *
 * Starten:
 *   node printserver.js
 */

const { printer: ThermalPrinter, types: PrinterTypes, characterSet } = require('node-thermal-printer');
const axios = require('axios');

// ── CONFIGURATIE ──────────────────────────────────────────────────────────────

const FIREBASE_URL = 'https://bestelappolvlombeek-default-rtdb.europe-west1.firebasedatabase.app';
const POLL_INTERVAL_MS = 2000;       // polling interval
const PRINTER_PORT = 9100;           // standaard ESC/POS netwerkpoort
const PRINTER_TIMEOUT_MS = 3000;
const SETTINGS_REFRESH_EVERY = 15;   // elke N polls (= 30s bij 2s interval)
const RETRY_BACKOFF_BASE_MS = 5000;  // herproberen na X ms bij fout
const MAX_RETRIES_BEFORE_ALERT = 10;

// ── STATE ─────────────────────────────────────────────────────────────────────

let settings = { printers: [], categories: [] };
let printAttempts = {}; // fbId -> {attempts, lastAttempt, lastError}
let settingsRefreshCounter = 0;

// ── FIREBASE HELPERS ──────────────────────────────────────────────────────────

async function fetchOrders() {
  try {
    const res = await axios.get(`${FIREBASE_URL}/orders.json`);
    if (!res.data) return [];
    // Behoud de Firebase key als fbId, of gebruik de eigen fbId in het object
    return Object.entries(res.data).map(([key, order]) => ({
      ...order,
      fbId: order.fbId || key,
      _firebaseKey: key
    }));
  } catch (e) {
    console.error('[Firebase] Fout bij ophalen orders:', e.message);
    return [];
  }
}

async function fetchSettings() {
  try {
    const res = await axios.get(`${FIREBASE_URL}/settings.json`);
    if (res.data) {
      settings = res.data;
      console.log(`[Settings] ${settings.printers?.length || 0} printers, ${settings.categories?.length || 0} categorieën geladen`);
    }
  } catch (e) {
    console.error('[Firebase] Fout bij ophalen instellingen:', e.message);
  }
}

async function updateOrderStatus(firebaseKey, patch) {
  try {
    await axios.patch(`${FIREBASE_URL}/orders/${firebaseKey}.json`, patch);
  } catch (e) {
    console.error(`[Firebase] Fout bij updaten order ${firebaseKey}:`, e.message);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getPrinterForId(printerId) {
  return (settings.printers || []).find(p => p.id === printerId);
}
function getCategoryForId(catId) {
  return (settings.categories || []).find(c => c.id === catId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── PRINTER ───────────────────────────────────────────────────────────────────

async function printTicket(printerConfig, lines, headerText) {
  if (!printerConfig.ip) {
    console.warn(`[Printer:${printerConfig.name}] Geen IP, toon op console:`);
    console.log('-'.repeat(40));
    console.log(`${headerText}\n${lines.join('\n')}`);
    console.log('-'.repeat(40));
    return { success: true, simulated: true };
  }

  // Expliciete poort 9100 voor ESC/POS netwerkprinters
  const ipWithPort = printerConfig.ip.includes(':') 
    ? printerConfig.ip 
    : `${printerConfig.ip}:${PRINTER_PORT}`;

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${ipWithPort}`,
    characterSet: characterSet?.PC858_EURO || 'PC858_EURO', // Euro + West-Europese accenten
    removeSpecialCharacters: false,
    timeout: PRINTER_TIMEOUT_MS,
  });

  try {
    const connected = await printer.isPrinterConnected();
    if (!connected) {
      return { success: false, error: 'Niet bereikbaar' };
    }

    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(headerText);
    printer.setTextSize(0, 0);
    printer.bold(false);
    printer.drawLine();

    for (const line of lines) {
      if (line === '---') {
        printer.drawLine();
      } else if (line.startsWith('  > ')) {
        printer.alignLeft();
        printer.println(line); // variatie
      } else if (line.startsWith('  * ')) {
        printer.alignLeft();
        printer.invert(true);
        printer.println(line.replace('  * ', ' ! '));
        printer.invert(false);
      } else if (line.startsWith('QTY:')) {
        printer.alignLeft();
        printer.bold(true);
        printer.println(line.replace('QTY:', ''));
        printer.bold(false);
      } else if (line.startsWith('TOTAL:')) {
        printer.drawLine();
        printer.alignRight();
        printer.bold(true);
        printer.setTextSize(1, 1);
        printer.println(line.replace('TOTAL:', ''));
        printer.setTextSize(0, 0);
        printer.bold(false);
      } else {
        printer.alignLeft();
        printer.println(line);
      }
    }

    printer.drawLine();
    printer.cut();

    const executed = await printer.execute();
    if (!executed) {
      return { success: false, error: 'Execute mislukt' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── ORDER VERWERKEN ───────────────────────────────────────────────────────────

async function processOrder(order) {
  console.log(`\n[Order] ${order.fbId} — Tafel ${order.table} | ${order.name} | 👤 ${order.waiter || '—'}`);

  // Groepeer items per printer via categorie-mapping
  const printerItems = {}; // printerId -> [items]
  order.items.forEach(item => {
    const cat = getCategoryForId(item.cat);
    if (!cat || !cat.printers) {
      console.warn(`  ⚠ Categorie '${item.cat}' geen printer-mapping`);
      return;
    }
    cat.printers.forEach(pid => {
      const printer = getPrinterForId(pid);
      if (!printer || printer.isBill) return; // kassaprinter krijgt enkel rekening, geen orderticket
      if (!printerItems[pid]) printerItems[pid] = [];
      printerItems[pid].push(item);
    });
  });

  if (Object.keys(printerItems).length === 0) {
    console.warn(`  ⚠ Geen printers gevonden voor deze order, sla over.`);
    return { success: true, printed: 0 };
  }

  // Print naar elke printer
  let allSuccess = true;
  const errors = [];
  let printed = 0;

  for (const [printerId, items] of Object.entries(printerItems)) {
    const printerConfig = getPrinterForId(printerId);
    const time = new Date().toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
    const headerText = `${printerConfig.name.toUpperCase()} - ${time}`;
    const lines = [
      `Tafel ${order.table} | ${order.name}`,
      `Opnemer: ${order.waiter || '—'}`,
      '---',
    ];
    items.forEach(i => {
      lines.push(`QTY:${i.qty}x ${i.name}`);
      if (i.variation) lines.push(`  > ${i.variation}`);
      if (i.comment) lines.push(`  * ${i.comment}`);
    });

    const result = await printTicket(printerConfig, lines, headerText);
    if (result.success) {
      console.log(`  ✓ ${printerConfig.name}` + (result.simulated ? ' (console)' : ` (${printerConfig.ip})`));
      printed++;
    } else {
      console.error(`  ✗ ${printerConfig.name}: ${result.error}`);
      errors.push({ printer: printerConfig.name, error: result.error });
      allSuccess = false;
    }
  }

  return { success: allSuccess, printed, errors };
}

// ── POLLING LOOP ──────────────────────────────────────────────────────────────

async function poll() {
  // Periodiek instellingen herladen
  settingsRefreshCounter++;
  if (settingsRefreshCounter >= SETTINGS_REFRESH_EVERY) {
    await fetchSettings();
    settingsRefreshCounter = 0;
  }

  const orders = await fetchOrders();

  for (const order of orders) {
    if (!order.fbId) continue;
    if (order.paid) continue;
    if (order.printStatus === 'printed') continue;

    // Backoff: niet te snel opnieuw proberen bij fouten
    const attempts = printAttempts[order.fbId] || { attempts: 0, lastAttempt: 0 };
    const sinceLast = Date.now() - attempts.lastAttempt;
    const requiredWait = RETRY_BACKOFF_BASE_MS * Math.min(attempts.attempts, 6);
    if (attempts.attempts > 0 && sinceLast < requiredWait) continue;

    attempts.attempts++;
    attempts.lastAttempt = Date.now();
    printAttempts[order.fbId] = attempts;

    const result = await processOrder(order);

    if (result.success) {
      // Markeer als gedrukt in Firebase zodat andere servers (en de admin UI) dit zien
      await updateOrderStatus(order._firebaseKey, {
        printStatus: 'printed',
        printedAt: Date.now(),
        printedTickets: result.printed
      });
      delete printAttempts[order.fbId];
    } else {
      console.warn(`[Retry] ${order.fbId} — poging ${attempts.attempts}, opnieuw over ${Math.round(requiredWait/1000)}s`);
      if (attempts.attempts >= MAX_RETRIES_BEFORE_ALERT) {
        await updateOrderStatus(order._firebaseKey, {
          printStatus: 'error',
          printError: result.errors?.map(e => `${e.printer}: ${e.error}`).join(' | '),
          printAttempts: attempts.attempts
        });
      }
    }
  }
}

// ── START ─────────────────────────────────────────────────────────────────────

async function start() {
  console.log('╔════════════════════════════════════╗');
  console.log('║   Popup Restaurant — Printserver   ║');
  console.log('╚════════════════════════════════════╝');
  console.log(`Firebase: ${FIREBASE_URL}`);
  console.log(`Poll: ${POLL_INTERVAL_MS}ms · Printer port: ${PRINTER_PORT}\n`);

  await fetchSettings();

  // Markeer alle bestaande gedrukte/betaalde orders als gekend (niet opnieuw afdrukken)
  const existingOrders = await fetchOrders();
  const alreadyHandled = existingOrders.filter(o => o.paid || o.printStatus === 'printed').length;
  console.log(`[Start] ${existingOrders.length} orders gevonden, waarvan ${alreadyHandled} al verwerkt\n`);

  // Polling starten
  setInterval(poll, POLL_INTERVAL_MS);
  console.log('[Start] Luisteren naar nieuwe bestellingen...\n');
}

process.on('SIGINT', () => {
  console.log('\n[Stop] Server gestopt.');
  process.exit(0);
});

start();
