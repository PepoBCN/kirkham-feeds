export default async (req) => {
  const url = new URL(req.url);
  const rssUrl = url.searchParams.get('url');

  if (!rssUrl) {
    return new Response('Missing url parameter', { status: 400 });
  }

  if (!rssUrl.startsWith('https://news.google.com/rss/')) {
    return new Response('Only Google News RSS URLs are allowed', { status: 403 });
  }

  try {
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'KirkhamFeeds/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
    });

    if (!response.ok) {
      return new Response(`Upstream returned ${response.status}`, { status: response.status });
    }

    const body = await response.text();

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    return new Response('Failed to fetch RSS feed', { status: 502 });
  }
};
