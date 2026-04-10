/**
 * CodexMC Version Registry
 * Dynamically fetches available MC versions for each mod loader
 */

const axios = require('axios');

// Cache TTL: 1 hour
const CACHE_TTL = 3600000;
const cache = {};

function cached(key, fetcher) {
  const now = Date.now();
  if (cache[key] && (now - cache[key].time) < CACHE_TTL) {
    return Promise.resolve(cache[key].data);
  }
  return fetcher().then(data => {
    cache[key] = { data, time: now };
    return data;
  });
}

// ── Forge ────────────────────────────────────────────────────────────────────
async function getForgeVersions() {
  return cached('forge', async () => {
    try {
      const res = await axios.get('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json', {
        timeout: 10000
      });
      // Returns object: { "1.20.1": ["47.2.0", ...], ... }
      const data = res.data;
      const versions = Object.keys(data)
        .filter(v => {
          const parts = v.split('.').map(Number);
          // Only MC 1.7+ where Forge is meaningful
          return parts[1] >= 7;
        })
        .sort((a, b) => {
          const pa = a.split('.').map(Number);
          const pb = b.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            const diff = (pb[i] || 0) - (pa[i] || 0);
            if (diff !== 0) return diff;
          }
          return 0;
        })
        .slice(0, 50); // Latest 50 MC versions
      return versions.map(v => ({
        mcVersion: v,
        forgeVersions: (data[v] || []).slice(0, 5), // Top 5 forge builds
        recommended: data[v] ? data[v][0] : null
      }));
    } catch (e) {
      console.warn('Forge version fetch failed, using fallback:', e.message);
      return getForgeFallback();
    }
  });
}

function getForgeFallback() {
  return [
    { mcVersion: '1.21.1', forgeVersions: ['52.0.29'], recommended: '52.0.29' },
    { mcVersion: '1.20.6', forgeVersions: ['50.1.0'], recommended: '50.1.0' },
    { mcVersion: '1.20.4', forgeVersions: ['49.1.0'], recommended: '49.1.0' },
    { mcVersion: '1.20.1', forgeVersions: ['47.3.0', '47.2.20'], recommended: '47.3.0' },
    { mcVersion: '1.19.4', forgeVersions: ['45.3.0'], recommended: '45.3.0' },
    { mcVersion: '1.19.2', forgeVersions: ['43.3.0'], recommended: '43.3.0' },
    { mcVersion: '1.18.2', forgeVersions: ['40.2.0'], recommended: '40.2.0' },
    { mcVersion: '1.16.5', forgeVersions: ['36.2.39'], recommended: '36.2.39' },
    { mcVersion: '1.12.2', forgeVersions: ['14.23.5.2860'], recommended: '14.23.5.2860' },
    { mcVersion: '1.8.9',  forgeVersions: ['11.15.1.2318'], recommended: '11.15.1.2318' },
  ];
}

// ── Fabric ────────────────────────────────────────────────────────────────────
async function getFabricVersions() {
  return cached('fabric', async () => {
    try {
      const [gameRes, loaderRes] = await Promise.all([
        axios.get('https://meta.fabricmc.net/v2/versions/game', { timeout: 10000 }),
        axios.get('https://meta.fabricmc.net/v2/versions/loader', { timeout: 10000 }),
      ]);

      const stableGames = gameRes.data
        .filter(v => v.stable)
        .slice(0, 30)
        .map(v => v.version);

      const latestLoader = loaderRes.data.find(l => l.stable)?.version || '0.15.9';

      return stableGames.map(v => ({
        mcVersion: v,
        loaderVersion: latestLoader,
        apiVersion: getFabricApiVersion(v)
      }));
    } catch (e) {
      console.warn('Fabric version fetch failed, using fallback:', e.message);
      return getFabricFallback();
    }
  });
}

function getFabricApiVersion(mcVersion) {
  // Approximate Fabric API versions by MC version
  const map = {
    '1.21': '0.100.0+1.21',
    '1.20.6': '0.100.0+1.20.6',
    '1.20.4': '0.97.0+1.20.4',
    '1.20.1': '0.92.1+1.20.1',
    '1.19.4': '0.87.2+1.19.4',
    '1.19.2': '0.77.0+1.19.2',
    '1.18.2': '0.77.0+1.18.2',
  };
  const major = mcVersion.split('.').slice(0, 2).join('.');
  return map[mcVersion] || map[major] || `0.92.0+${mcVersion}`;
}

function getFabricFallback() {
  return [
    { mcVersion: '1.21.4', loaderVersion: '0.16.9', apiVersion: '0.110.0+1.21.4' },
    { mcVersion: '1.21.3', loaderVersion: '0.16.9', apiVersion: '0.107.3+1.21.3' },
    { mcVersion: '1.21.1', loaderVersion: '0.16.5', apiVersion: '0.102.0+1.21.1' },
    { mcVersion: '1.21',   loaderVersion: '0.15.11', apiVersion: '0.100.0+1.21' },
    { mcVersion: '1.20.6', loaderVersion: '0.15.11', apiVersion: '0.100.0+1.20.6' },
    { mcVersion: '1.20.4', loaderVersion: '0.15.7', apiVersion: '0.97.0+1.20.4' },
    { mcVersion: '1.20.1', loaderVersion: '0.14.22', apiVersion: '0.92.1+1.20.1' },
    { mcVersion: '1.19.4', loaderVersion: '0.14.21', apiVersion: '0.87.2+1.19.4' },
    { mcVersion: '1.19.2', loaderVersion: '0.14.21', apiVersion: '0.77.0+1.19.2' },
    { mcVersion: '1.18.2', loaderVersion: '0.13.3', apiVersion: '0.77.0+1.18.2' },
  ];
}

// ── NeoForge ─────────────────────────────────────────────────────────────────
async function getNeoForgeVersions() {
  return cached('neoforge', async () => {
    try {
      const res = await axios.get('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', {
        timeout: 10000
      });
      const xml = res.data;
      // Parse versions from XML
      const matches = xml.match(/<version>([^<]+)<\/version>/g) || [];
      const versions = matches
        .map(m => m.replace(/<\/?version>/g, ''))
        .filter(v => !v.includes('beta') && !v.includes('alpha') && !v.includes('rc'))
        .reverse();

      // Group by MC version (NeoForge version starts with MC minor, e.g. 21.1.x = MC 1.21.1)
      const grouped = {};
      for (const v of versions) {
        const parts = v.split('.');
        // NeoForge: 21.1.77 → MC 1.21.1
        const mcMajor = parseInt(parts[0]);
        const mcMinor = parseInt(parts[1]);
        const mcVersion = `1.${mcMajor}.${mcMinor}`;
        if (!grouped[mcVersion]) grouped[mcVersion] = [];
        grouped[mcVersion].push(v);
      }

      return Object.entries(grouped)
        .sort(([a], [b]) => {
          const pa = a.split('.').map(Number);
          const pb = b.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            const diff = (pb[i] || 0) - (pa[i] || 0);
            if (diff !== 0) return diff;
          }
          return 0;
        })
        .slice(0, 20)
        .map(([mcVersion, nfVersions]) => ({
          mcVersion,
          neoforgeVersions: nfVersions.slice(0, 5),
          recommended: nfVersions[0]
        }));
    } catch (e) {
      console.warn('NeoForge version fetch failed, using fallback:', e.message);
      return getNeoForgeFallback();
    }
  });
}

function getNeoForgeFallback() {
  return [
    { mcVersion: '1.21.4', neoforgeVersions: ['21.4.70'], recommended: '21.4.70' },
    { mcVersion: '1.21.3', neoforgeVersions: ['21.3.90'], recommended: '21.3.90' },
    { mcVersion: '1.21.1', neoforgeVersions: ['21.1.77'], recommended: '21.1.77' },
    { mcVersion: '1.21',   neoforgeVersions: ['21.0.167'], recommended: '21.0.167' },
    { mcVersion: '1.20.6', neoforgeVersions: ['20.6.119'], recommended: '20.6.119' },
    { mcVersion: '1.20.4', neoforgeVersions: ['20.4.237'], recommended: '20.4.237' },
    { mcVersion: '1.20.2', neoforgeVersions: ['20.2.88'], recommended: '20.2.88' },
    { mcVersion: '1.20.1', neoforgeVersions: ['47.1.99'], recommended: '47.1.99' },
  ];
}

// ── JDK requirement mapper ────────────────────────────────────────────────────
function getRequiredJdk(mcVersion) {
  const [, major, minor] = mcVersion.split('.').map(Number);
  if (major === 1) {
    if (minor >= 21) return '21';
    if (minor >= 17) return '17';
    if (minor >= 7)  return '8';
  }
  return '21';
}

module.exports = { getForgeVersions, getFabricVersions, getNeoForgeVersions, getRequiredJdk };
