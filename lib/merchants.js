// What a subscription probably is, in words a person recognises.
//
// Statements use names nobody knows ("Expressco", "Google", "Amazon Prime
// Video"). Each subscription gets, where it can be told:
//   known_as  a short recognisable name, shown in brackets after the statement name
//   about     one or two sentences on what the charge could be
// From a list of companies that bill under other names, and from the
// subscription that stopped as this one began, at the same price and on the
// same day of the month (ExpressVPN became "Expressco" on Shine's statement).

const KNOWN = [
  [/prime video|primevideo/, null, 'Bought through Prime Video, apart from Prime itself: often an add-on channel such as Paramount+, Max, Starz, AMC+ or BritBox, or a rental. Your Amazon account lists them under Prime Video Channels.'],
  [/amazon prime|amzn prime|prime membership/, 'Amazon Prime membership', 'The Prime membership itself: shipping, Prime Video and Prime Music.'],
  [/kindle/, 'Kindle Unlimited', 'Usually Kindle Unlimited, or a magazine or newspaper bought for Kindle.'],
  [/audible/, 'Audible', 'An Audible audiobook membership.'],
  [/^apple$|apple\.com|itunes/, 'Apple subscriptions', 'Apple bills every App Store subscription under its own name: iCloud+, Apple Music, Apple TV+, Apple One, or an app bought through the App Store. Settings, your name, Subscriptions on an iPhone lists them.'],
  [/google one/, 'Google One storage', 'Google One: extra storage for Gmail, Drive and Photos, sometimes with Gemini.'],
  [/youtube/, 'YouTube Premium', 'YouTube Premium or YouTube TV.'],
  [/^google$|google \*|google play/, 'Google subscriptions', 'Google bills YouTube Premium, Google One storage, Google Play app subscriptions and Workspace under "Google". myaccount.google.com, Payments and subscriptions, lists them.'],
  [/openai|chatgpt/, 'ChatGPT', 'OpenAI: a ChatGPT Plus or Team plan, or use of its API.'],
  [/anthropic|claude/, 'Claude', 'Anthropic: a Claude Pro or Max plan, or use of its API.'],
  [/^hbo|max\.com|hbomax/, 'Max (HBO)', 'Max, the HBO streaming service.'],
  [/hulu/, 'Hulu', 'Hulu streaming, possibly with Disney+ or live TV.'],
  [/disney/, 'Disney+', 'Disney+, possibly bundled with Hulu or ESPN+.'],
  [/netflix/, 'Netflix', 'Netflix streaming.'],
  [/spotify/, 'Spotify', 'Spotify Premium (Individual, Duo or Family).'],
  [/capcut/, 'CapCut Pro', 'CapCut Pro, the video editor from the makers of TikTok.'],
  [/walmart\+|walmart plus/, 'Walmart+', 'The Walmart+ membership: delivery, fuel savings and Paramount+ Essential.'],
  [/spokeo/, 'Spokeo', 'Spokeo, a people-search service.'],
  [/godaddy/, 'GoDaddy', 'GoDaddy: a website, domain, email or hosting plan.'],
  [/fly\.io/, 'Fly.io hosting', 'Fly.io, app hosting billed by use.'],
  [/twilio/, 'Twilio', 'Twilio: phone numbers, calls and texts for apps, billed by use.'],
  [/vercel/, 'Vercel hosting', 'Vercel website hosting.'],
  [/supabase/, 'Supabase', 'Supabase database hosting.'],
  [/usage\.ai|use\.ai/, 'Usage.ai', 'Usage.ai, cloud cost savings software.'],
  [/qr-code|qr code/, 'QR code generator', 'A QR code generator plan (qr-code.io), keeping its dynamic codes working.'],
  [/expressvpn|expressco/, 'ExpressVPN', 'ExpressVPN, a VPN service.'],
  [/24 hour fitness/, '24 Hour Fitness', '24 Hour Fitness: the monthly membership, and separately any personal training or an annual fee.'],
  [/oil changers/, 'Oil Changers wash club', 'The Oil Changers unlimited car wash club.'],
  [/replit/, 'Replit', 'Replit, an online coding tool with AI.'],
  [/gptzero/, 'GPTZero', 'GPTZero, which checks whether text was written by AI.'],
  [/bark/, 'Bark', 'Bark: either the bark.com leads service (credits for customer requests) or BarkBox for a dog.'],
  [/dressly/, null, null],
  [/distrokid/, 'DistroKid', 'DistroKid, which puts music on Spotify and Apple Music.'],
  [/suno/, 'Suno', 'Suno, the AI music maker.'],
  [/microsoft/, 'Microsoft 365', 'Usually Microsoft 365 (Word, Excel, OneDrive), or Xbox.'],
  [/adobe/, 'Adobe', 'An Adobe plan: Acrobat, Photoshop, Lightroom or Creative Cloud.'],
  [/canva/, 'Canva Pro', 'Canva Pro, the design tool.'],
  [/zoom/, 'Zoom', 'A Zoom meetings plan.'],
  [/paddle/, null, 'Paddle collects payment for many software makers; the receipt email says which app it was.'],
  [/paypal/, null, 'Paid through PayPal; your PayPal activity names the company.'],
];

const day = (iso) => Number(String(iso).slice(8, 10));
const near = (a, b) => Math.abs(a - b) <= Math.max(0.02, 0.01 * Math.max(a, b));

/// Adds known_as and about to each subscription, where something can be said.
export function identify(subs) {
  for (const s of subs) {
    const lower = (s.description || '').toLowerCase().trim();
    const hit = KNOWN.find(([re]) => re.test(lower));
    let knownAs = hit?.[1] ?? null;
    let about = hit?.[2] ?? null;

    // The one it replaced: stopped when this began, same price, same day of the month.
    const before = subs.find((o) => o !== s && !o.is_active && o.kind === s.kind && near(o.average_amount, s.average_amount)
      && Math.abs(day(o.last_date) - day(s.first_date || s.last_date)) <= 3 && o.last_date < (s.first_date || s.last_date)
      && o.description.toLowerCase() !== lower);
    if (before && s.is_active) {
      const was = KNOWN.find(([re]) => re.test(before.description.toLowerCase()))?.[1] || before.description;
      knownAs = knownAs && knownAs !== was && !/subscriptions$/.test(knownAs) ? knownAs : was;
      about = `Same price and same day of the month as ${before.description}, which stopped when this began: probably ${was} under a new name on your statement.` + (about && !/^Google bills|^Apple bills/.test(about) ? '' : about ? ` ${about}` : '');
    }

    // A statement name that already says it is not repeated in brackets.
    if (knownAs && lower.replace(/[^a-z0-9]/g, '').includes(knownAs.toLowerCase().replace(/[^a-z0-9]/g, ''))) knownAs = null;
    s.known_as = knownAs;
    s.about = about;
  }
  return subs;
}
