import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { InvestingRow } from '../types.js';
import {
  parseInvestingEps,
  parseInvestingRevenue,
  parseInvestingSurprise,
  parseInvestingTiming,
} from './investingParser.js';

// Setup stealth plugin on puppeteer-extra
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pExtra = puppeteerExtra as any;
pExtra.use(StealthPlugin());

function findBrowserExecutable(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(p)) return p;
  const chrome64 = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (existsSync(chrome64)) return chrome64;
  const chrome32 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  if (existsSync(chrome32)) return chrome32;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (existsSync(edge)) return edge;
  throw new Error('No Chrome/Chromium found (set CHROME_PATH)');
}

export class InvestingScraper {
  private browser: Browser | null = null;
  private isBusy = false;
  private readonly profileDir: string;

  constructor(profileDir?: string) {
    this.profileDir = profileDir ?? path.resolve('./data/investing_profile');
    mkdirSync(this.profileDir, { recursive: true });
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }

    const execPath = findBrowserExecutable();
    this.browser = (await pExtra.launch({
      headless: 'new',
      executablePath: execPath,
      userDataDir: this.profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
        '--disable-gpu',
        '--no-first-run',
        '--disable-background-networking',
      ],
    })) as Browser;

    this.browser.on('disconnected', () => {
      this.browser = null;
    });

    return this.browser;
  }

  /**
   * Scrapes earnings for the given tab ('today' or 'yesterday').
   * Returns parsed rows with actual and estimate EPS/revenue.
   */
  async fetchCalendar(tab: 'today' | 'yesterday' = 'today', targetDateStr: string): Promise<InvestingRow[]> {
    if (this.isBusy) throw new Error('Investing.com scraper still busy with the previous run');

    this.isBusy = true;
    let page: Page | null = null;

    try {
      const browser = await this.getBrowser();
      page = await browser.newPage();
      page.setDefaultTimeout(30_000);
      await page.setViewport({ width: 1920, height: 1080 });

      // Navigate to earnings calendar
      await page.goto('https://www.investing.com/earnings-calendar', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Allow Cloudflare verification & initial table render
      await new Promise((r) => setTimeout(r, 3500));

      if (tab === 'yesterday') {
        // Click the Yesterday button if requested
        const clicked = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          const buttons = Array.from(doc.querySelectorAll('button, a')) as any[];
          const btn = buttons.find((b: any) => (b.innerText || '').trim() === 'Yesterday' || b.getAttribute('data-test') === 'yesterday-tab');
          if (!btn || typeof btn.click !== 'function') return false;
          btn.click();
          return true;
        });
        // Without the tab switch the page still shows today's rows; never label them as yesterday's.
        if (!clicked) throw new Error('Investing.com: "Yesterday" tab not found');
        await new Promise((r) => setTimeout(r, 2500));
      }

      // Extract raw table data from the page
      const rawRows = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const rows: { ticker: string; name?: string; cells: string[] }[] = [];
        const tables = doc.querySelectorAll('table') as any[];
        tables.forEach((t: any) => {
          const trs = t.querySelectorAll('tbody tr') as any[];
          trs.forEach((tr: any) => {
            const text = (tr.innerText || '') as string;
            const tickerMatch = text.match(/\(\s*([A-Za-z0-9\.\-\_]+)\s*\)/);
            if (tickerMatch && tickerMatch[1]) {
              const cells = Array.from(tr.querySelectorAll('td')).map((td: any) => ((td.innerText || '') as string).trim());
              const nameText = cells[1] ? cells[1].split('(')[0]?.trim() : undefined;
              rows.push({
                ticker: tickerMatch[1],
                name: nameText,
                cells,
              });
            }
          });
        });
        return rows;
      });

      const parsed: InvestingRow[] = [];
      for (const r of rawRows) {
        if (!r.ticker || r.cells.length < 5) continue;

        const epsActual = parseInvestingEps(r.cells[2]);
        const epsEstimate = parseInvestingEps(r.cells[3]);
        const revenueActual = parseInvestingRevenue(r.cells[4]);
        const revenueEstimate = parseInvestingRevenue(r.cells[5]);
        const epsSurprisePct = parseInvestingSurprise(r.cells[11] ?? r.cells[12]);
        const timing = parseInvestingTiming(r.cells[0]);

        parsed.push({
          symbol: r.ticker.toUpperCase().trim(),
          name: r.name,
          reportDate: targetDateStr,
          timing,
          epsActual,
          epsEstimate,
          epsSurprisePct,
          revenueActual,
          revenueEstimate,
        });
      }

      return parsed;
    } catch (err) {
      // A hung or broken browser is discarded so the next run starts clean.
      const b = this.browser;
      this.browser = null;
      if (b) b.close().catch(() => {});
      throw err;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {}
      }
      this.isBusy = false;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }
}

let shared: InvestingScraper | null = null;
/** One scraper per process, created on first use (not at import). */
export function investingScraper(): InvestingScraper {
  shared ??= new InvestingScraper();
  return shared;
}
