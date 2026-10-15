// Records a HAR of one deployment with a real browser, for later comparison.
// Response bodies are omitted; REA decides what the capture contains.

const STEP = /^(click|fill|press|wait|waitfor|goto):(.*)$/s;

/** Parse "click:#send", "fill:#prompt=hello", "press:#prompt=Enter", "wait:1500", "waitfor:#done", "goto:/path". */
export const parseStep = (text) => {
  const match = STEP.exec(text);
  if (match === null)
    throw new Error(
      `Unknown step "${text}". Use click:, fill:, press:, wait:, waitfor: or goto:.`,
    );
  const [, action, rest] = match;
  if (action === "fill" || action === "press") {
    const split = rest.indexOf("=");
    if (split < 1)
      throw new Error(
        `Step "${text}" needs a selector and a value: ${action}:SELECTOR=VALUE`,
      );
    return {
      action,
      selector: rest.slice(0, split),
      value: rest.slice(split + 1),
    };
  }
  if (action === "wait") {
    const milliseconds = Number(rest);
    if (!Number.isInteger(milliseconds) || milliseconds < 0)
      throw new Error(`Step "${text}" needs a whole number of milliseconds.`);
    return { action, milliseconds };
  }
  return { action, value: rest };
};

const runStep = async (page, step, base) => {
  if (step.action === "click") await page.click(step.value);
  else if (step.action === "fill") await page.fill(step.selector, step.value);
  else if (step.action === "press") await page.press(step.selector, step.value);
  else if (step.action === "wait") await page.waitForTimeout(step.milliseconds);
  else if (step.action === "waitfor") await page.waitForSelector(step.value);
  else
    await page.goto(new URL(step.value, base).toString(), {
      waitUntil: "networkidle",
    });
};

/**
 * Load `url` in Chromium, run `steps`, wait `settleMs`, and write a HAR to
 * `out`. Service workers are blocked so every request reaches the capture.
 */
export const recordHar = async ({
  url,
  out,
  browser = null,
  browserArgs = [],
  steps = [],
  settleMs = 1000,
}) => {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch (error) {
    throw new Error(
      "release-watch record needs playwright-core: npm install playwright-core",
      { cause: error },
    );
  }
  const instance = await chromium.launch({
    executablePath: browser ?? process.env.CHROMIUM_PATH ?? undefined,
    args: browserArgs,
  });
  try {
    const context = await instance.newContext({
      recordHar: { path: out, content: "omit", mode: "full" },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    for (const step of steps) await runStep(page, step, url);
    await page.waitForTimeout(settleMs);
    await context.close();
  } finally {
    await instance.close();
  }
};
