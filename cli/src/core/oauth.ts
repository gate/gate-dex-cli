import open from "open";

export async function openBrowser(url: string): Promise<boolean> {
  try {
    await open(url);
    return true;
  } catch {
    printManualUrl(url);
    return false;
  }
}

function printManualUrl(url: string): void {
  const termLink = `\x1b]8;;${url}\x1b\\Click here to open\x1b]8;;\x1b\\`;
  console.log();
  console.log(`\x1b[33m⚠  Could not open browser automatically.\x1b[0m`);
  console.log(`\x1b[1m   ${termLink}\x1b[0m  or copy the URL below:`);
  console.log();
  console.log(`   \x1b[36m${url}\x1b[0m`);
  console.log();
}
