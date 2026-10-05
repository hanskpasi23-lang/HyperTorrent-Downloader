const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'https://tracker.tamersunion.org:443/announce'
];

const TRACKER_QUERY_STRING = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');

export class SearchEngine {
  /**
   * Search torrent swarms and filter by health (seeders)
   * @param {string} query
   * @param {object} options
   */
  async search(query, options = {}) {
    if (!query || typeof query !== 'string') {
      return [];
    }

    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    try {
      const url = `https://apibay.org/q.php?q=${encodeURIComponent(cleanQuery)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HyperTorrent/1.0'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`Search indexer error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        return [];
      }

      // Filter out invalid/empty responses (apibay returns 0000... hash when no results)
      const validResults = data.filter(item => 
        item.info_hash && 
        item.info_hash !== '0000000000000000000000000000000000000000' &&
        item.name && item.name !== 'No results returned'
      );

      // Map, format, and construct magnet links
      const formatted = validResults.map(item => {
        const seeders = parseInt(item.seeders, 10) || 0;
        const leechers = parseInt(item.leechers, 10) || 0;
        const sizeBytes = parseInt(item.size, 10) || 0;
        const infoHash = item.info_hash.toLowerCase();
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.name)}${TRACKER_QUERY_STRING}`;

        return {
          id: item.id,
          name: item.name,
          infoHash: infoHash,
          seeders: seeders,
          leechers: leechers,
          sizeBytes: sizeBytes,
          category: this.mapCategory(item.category),
          numFiles: parseInt(item.num_files, 10) || 1,
          added: parseInt(item.added, 10) || 0,
          magnetURI: magnetURI,
          healthScore: seeders * 2 + leechers // High seeders = high speed
        };
      });

      // Filter & Sort: Place torrents with the highest seeders at the top
      formatted.sort((a, b) => b.seeders - a.seeders);

      return formatted;
    } catch (err) {
      console.error('[SearchEngine Error]:', err.message);
      return [];
    }
  }

  /**
   * Sniff any webpage URL for magnet and .torrent links
   * @param {string} pageUrl
   */
  async sniffWebpage(pageUrl) {
    if (!pageUrl || typeof pageUrl !== 'string') {
      throw new Error('Valid pageUrl is required');
    }

    try {
      const response = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HyperTorrent/1.0'
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        throw new Error(`Failed to load page: HTTP ${response.status}`);
      }

      const html = await response.text();
      
      // Regex to capture magnet links
      const magnetRegex = /magnet:\?xt=urn:btih:([a-zA-Z0-9]{32,40})[^"'<>\s]*/gi;
      const matches = html.match(magnetRegex) || [];

      // Deduplicate by InfoHash
      const uniqueMagnets = new Map();
      for (const rawMagnet of matches) {
        const hashMatch = rawMagnet.match(/urn:btih:([a-zA-Z0-9]{32,40})/i);
        if (hashMatch) {
          const hash = hashMatch[1].toLowerCase();
          if (!uniqueMagnets.has(hash)) {
            // Extract display name if present
            const dnMatch = rawMagnet.match(/dn=([^&]+)/i);
            const name = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : `Torrent ${hash.substring(0, 8)}...`;
            
            uniqueMagnets.set(hash, {
              infoHash: hash,
              name: name,
              magnetURI: rawMagnet
            });
          }
        }
      }

      return Array.from(uniqueMagnets.values());
    } catch (err) {
      console.error('[Web Sniffer Error]:', err.message);
      throw err;
    }
  }

  mapCategory(catCode) {
    const code = String(catCode || '');
    if (code.startsWith('1')) return 'Audio';
    if (code.startsWith('2')) return 'Video';
    if (code.startsWith('3')) return 'Applications';
    if (code.startsWith('4')) return 'Games';
    if (code.startsWith('6')) return 'Other';
    return 'General';
  }
}

export default SearchEngine;
