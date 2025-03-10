// src/index.ts
import { Agent, AgentNamespace, getAgentByName } from 'agents-sdk';

import { Ai } from '@cloudflare/ai';
import puppeteer, { BrowserWorker } from '@cloudflare/puppeteer';

// Define the agent's state structure
interface ArtHistoryState {
    recentQueries: string[];
    userInteractions: number;
    popularQueries: Record<string, number>;
}

// Define artwork structure
interface Artwork {
    title: string;
    artist: string;
    year: string;
    era: string;
    imageUrl: string;
    annotation: string;
}

// Define environment bindings
interface Env {
    // Agent namespace
    ART_HISTORY_AGENT: AgentNamespace<ArtHistoryAgent>;

    // AI capabilities
    AI: Ai;

    // Browser Rendering
    BROWSER: BrowserWorker;

    // Static assets
    ASSETS: any;
}

export class ArtHistoryAgent extends Agent<Env, ArtHistoryState> {
    async onStart() {
        console.log('Agent started');
    }

    // Handle HTTP requests
    async onRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);

        console.log('request received');
        // Route to frontend assets if not targeting the API
        if (!url.pathname.startsWith('/api/')) {
            return this.env.ASSETS.fetch(request);
        }

        // Process query from form submission
        if (url.pathname === '/api/query' && request.method === 'POST') {
            try {
                const formData = await request.formData();
                const query = formData.get('query')?.toString() || '';

                if (!query) {
                    return Response.json(
                        {error: 'Query is required'},
                        {status: 400},
                    );
                }

                // Update state
                this.updateQueryStats(query);

                // Process the query and return results
                const results = await this.processArtQuery(query);
                return Response.json(results);
            } catch (error) {
                console.error('Error processing query:', error);
                return Response.json(
                    {error: 'Failed to process query'},
                    {status: 500},
                );
            }
        }

        // Default to 404 for unknown endpoints
        return Response.json({error: 'Not found'}, {status: 404});
    }

    // Handle WebSocket connections for real-time interactions
    async onConnect(connection: any) {
        connection.accept();

        // Send welcome message
        connection.send(
            JSON.stringify({
                type: 'welcome',
                message:
                    'Connected to Art History AI. Send queries about biblical narratives to explore historical religious artwork.',
            }),
        );
    }

    // Handle WebSocket messages
    async onMessage(connection: any, message: any) {
        try {
            const data = JSON.parse(message);

            if (data.type === 'query' && data.content) {
                // Track interaction
                this.updateQueryStats(data.content);

                // Send processing notification
                connection.send(
                    JSON.stringify({
                        type: 'status',
                        status: 'processing',
                        message: 'Searching for artistic depictions...',
                    }),
                );

                // Process the query
                const results = await this.processArtQuery(data.content);

                // Send results
                connection.send(
                    JSON.stringify({
                        type: 'results',
                        results,
                    }),
                );
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            connection.send(
                JSON.stringify({
                    type: 'error',
                    message: 'Failed to process your request',
                }),
            );
        }
    }

    // Process art history query
    private async processArtQuery(query: string) {
        // Initialize AI
        const ai = new Ai(this.env.AI);

        // 1. Analyze the query to identify biblical narrative
        const narrativeAnalysis = await ai.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
                {
                    role: 'system',
                    content:
                        'You are an expert in biblical narratives and art history. Identify the specific biblical narrative being referenced, the key figures involved, and important theological elements that artists might depict.',
                },
                {role: 'user', content: query},
            ],
        });

        // 2. Generate a list of notable artworks depicting this narrative
        const artworkList = await ai.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
                {
                    role: 'system',
                    content: `You are an art history expert specializing in religious art.
        Generate a list of 10 significant artworks depicting biblical narratives from different historical periods.
        For each artwork include:
        1. Title
        2. Artist
        3. Year created (approximate if necessary)
        4. Art historical period/era (e.g., Renaissance, Baroque, etc.)

        Ensure you include a diverse range of historical periods and artistic styles.
        Format your response as valid JSON with this structure:
        [
          {
            "title": "Title of Artwork",
            "artist": "Artist Name",
            "year": "Year or Year Range",
            "era": "Art Historical Period"
          }
        ]`,
                },
                {
                    role: 'user',
                    content: `Generate a list of significant artworks depicting the following biblical narrative: ${narrativeAnalysis}`,
                },
            ],
        });

        // 3. Parse the artwork list
        let artworks: Array<Omit<Artwork, 'imageUrl' | 'annotation'>> = [];
        try {
            artworks = JSON.parse(JSON.stringify(artworkList));
        } catch (error) {
            console.error('Error parsing artwork list:', error);
            artworks = extractArtworksManually(JSON.stringify(artworkList));
        }

        // 4. Find images and annotate artworks
        const processedArtworks = await this.findImagesAndAnnotate(
            artworks,
            JSON.stringify(narrativeAnalysis),
            query,
        );

        // 5. Group artworks by era
        const byEra = processedArtworks.reduce<Record<string, Artwork[]>>(
            (acc, artwork) => {
                const era = artwork.era || 'Unknown';
                if (!acc[era]) acc[era] = [];
                acc[era].push(artwork);
                return acc;
            },
            {},
        );

        // Get the narrative text from the AI response
        const narrativeText =
            typeof narrativeAnalysis === 'string'
                ? narrativeAnalysis
                : 'response' in narrativeAnalysis
                ? narrativeAnalysis.response
                : JSON.stringify(narrativeAnalysis);

        // 6. Return complete results
        return {
            query,
            narrative: extractNarrativeTitle(JSON.stringify(narrativeText)),
            narrativeDescription: narrativeText,
            artworks: {
                all: processedArtworks,
                byEra,
            },
        };
    }

    // Find images for artworks using Browser Rendering API and add annotations
    private async findImagesAndAnnotate(
        artworks: any,
        narrativeDescription: string,
        originalQuery: string,
    ) {
        // Launch browser with Browser Rendering API
        const browser = await puppeteer.launch(this.env.BROWSER);
        const ai = new Ai(this.env.AI);

        const processedArtworks: Artwork[] = [];

        for (const artwork of artworks) {
            try {
                // Create search query for the artwork
                const searchQuery = `${artwork.title} ${artwork.artist} painting biblical art`;

                // Open new page and search for the artwork
                const page = await browser.newPage();
                await page.goto(
                    `https://www.google.com/search?q=${encodeURIComponent(
                        searchQuery,
                    )}&tbm=isch`,
                );

                // Wait for images to load
                await page.waitForSelector('img');

                // Get the first relevant image
                const imageUrl = await page.evaluate(() => {
                    // Find image elements that are likely to be the artwork
                    const images = Array.from(
                        document.querySelectorAll('img'),
                    ).filter((img) => img.width > 100 && img.height > 100); // Filter out tiny images

                    return images.length > 0 ? images[1].src : null; // Skip the first image (usually a Google logo)
                });

                // Generate annotation for the artwork
                const annotationPrompt = `
          Artwork: "${artwork.title}" by ${artwork.artist} (${artwork.year}, ${artwork.era})

          Biblical Narrative: ${narrativeDescription}

          Original Query: ${originalQuery}

          Provide an educational annotation for this artwork that:
          1. Explains how it depicts the biblical narrative
          2. Highlights artistic choices and symbolism
          3. Places it in historical and theological context
          4. Notes how it reflects the artistic style of its era (${artwork.era})

          Keep your annotation concise (about 150 words) and accessible to a general audience.
        `;

                const annotation = await ai.run(
                    '@cf/meta/llama-3-8b-instruct',
                    {
                        messages: [
                            {
                                role: 'system',
                                content:
                                    'You are an expert in art history and biblical studies. Provide insightful, educational annotations for religious artwork.',
                            },
                            {role: 'user', content: annotationPrompt},
                        ],
                    },
                );

                // Add to processed artworks
                processedArtworks.push({
                    ...artwork,
                    imageUrl:
                        imageUrl ||
                        'https://placehold.co/600x400?text=Image+Not+Found', // Fallback image
                    annotation: annotation,
                });

                // Close the page to free resources
                await page.close();
            } catch (error) {
                console.error(
                    `Error processing artwork "${artwork.title}":`,
                    error,
                );

                // Add with fallback image and error message
                processedArtworks.push({
                    ...artwork,
                    imageUrl:
                        'https://placehold.co/600x400?text=Image+Not+Found',
                    annotation: `We couldn't retrieve information for this artwork. The piece "${artwork.title}" by ${artwork.artist} (${artwork.year}) is a notable depiction of this biblical narrative from the ${artwork.era} period.`,
                });
            }
        }

        // Close the browser
        await browser.close();

        return processedArtworks;
    }

    // Update query statistics in agent state
    private updateQueryStats(query: string) {
        // Update recent queries list (keep last 10)
        const recentQueries = [query, ...this.state.recentQueries.slice(0, 9)];

        // Update popular queries count
        const popularQueries = {...this.state.popularQueries};
        popularQueries[query] = (popularQueries[query] || 0) + 1;

        // Update user interaction count
        const userInteractions = this.state.userInteractions + 1;

        // Update state
        this.setState({
            recentQueries,
            popularQueries,
            userInteractions,
        });
    }

    // Schedule daily analytics report
    async scheduleAnalyticsReport() {
        // Schedule a daily report at midnight
        await this.schedule('0 0 * * *', 'generateAnalyticsReport', {});
    }

    // Generate analytics report
    async generateAnalyticsReport() {
        // Get top queries
        const popularQueries = Object.entries(this.state.popularQueries)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        console.log('Top 10 Popular Queries:', popularQueries);

        // Store this data or send it somewhere
        // Could email to administrators, store in KV, etc.
    }
}

// Helper function to extract artworks manually if JSON parsing fails
function extractArtworksManually(
    text: string,
): Array<Omit<Artwork, 'imageUrl' | 'annotation'>> {
    // Fallback extraction logic for when the model doesn't output perfect JSON
    // This is a simple implementation - you might need a more robust approach

    const artworks = [];

    // Look for patterns like "1. Title" or "Title by Artist"
    const lines = text.split('\n');
    let currentArtwork = null;

    for (const line of lines) {
        // Check if line contains a title (often starts with a number or has quotes)
        if (
            line.match(/^\d+\.\s+["'](.+)["']/i) ||
            line.match(/["'](.+)["']\s+by/i)
        ) {
            // Start a new artwork
            if (currentArtwork && currentArtwork.title) {
                artworks.push(currentArtwork);
            }

            currentArtwork = {
                title: '',
                artist: '',
                year: '',
                era: '',
            };

            // Extract title
            const titleMatch = line.match(/["']([^"']+)["']/);
            if (titleMatch) {
                currentArtwork.title = titleMatch[1];
            }

            // Extract artist if on same line
            const artistMatch = line.match(/by\s+([^,(]+)/i);
            if (artistMatch) {
                currentArtwork.artist = artistMatch[1].trim();
            }
        } else if (currentArtwork) {
            // Try to extract year and era
            const yearMatch = line.match(/(\d{4}(?:\s*-\s*\d{4})?)/);
            if (yearMatch && !currentArtwork.year) {
                currentArtwork.year = yearMatch[1];
            }

            // Common art periods
            const eras = [
                'Renaissance',
                'Baroque',
                'Neoclassical',
                'Romantic',
                'Byzantine',
                'Medieval',
                'Gothic',
                'Early Christian',
                'Modern',
                'Contemporary',
            ];

            for (const era of eras) {
                if (line.includes(era) && !currentArtwork.era) {
                    currentArtwork.era = era;
                    break;
                }
            }
        }
    }

    // Add the last artwork if it exists
    if (currentArtwork && currentArtwork.title) {
        artworks.push(currentArtwork);
    }

    // If we've found no artworks, create some generic ones
    if (artworks.length === 0) {
        return [
            {
                title: 'The Last Supper',
                artist: 'Leonardo da Vinci',
                year: '1495-1498',
                era: 'Renaissance',
            },
            {
                title: 'The Creation of Adam',
                artist: 'Michelangelo',
                year: '1512',
                era: 'Renaissance',
            },
            {
                title: 'The Return of the Prodigal Son',
                artist: 'Rembrandt',
                year: '1669',
                era: 'Baroque',
            },
            {
                title: 'Christ in the Storm on the Sea of Galilee',
                artist: 'Rembrandt',
                year: '1633',
                era: 'Baroque',
            },
            {
                title: 'The Crucifixion',
                artist: 'Francisco de Goya',
                year: '1780',
                era: 'Romantic',
            },
        ];
    }

    return artworks;
}

// Helper function to extract a concise narrative title
function extractNarrativeTitle(narrativeDescription: string): string {
    // Look for the first sentence or the first 10 words
    const firstSentence = narrativeDescription.split(/\.\s+/)[0];

    if (firstSentence.length <= 60) {
        return firstSentence;
    }

    // Get first 10 words if the sentence is too long
    const words = narrativeDescription.split(/\s+/);
    return words.slice(0, 10).join(' ') + '...';
}

// Worker entrypoint
export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        // Durable Objects-style addressing
        // Best for: controlling ID generation, associating IDs with your existing systems,
        // and customizing when/how an Agent is created or invoked
        const id = env.ART_HISTORY_AGENT.newUniqueId();
        const agent = env.ART_HISTORY_AGENT.get(id);
        // Pass the incoming request straight to your Agent
        let resp = await agent.fetch(request);

        return Response.json(
            {error: 'Welcome to Biblical Art Explorer'},
            {status: 200},
        );
    },
};
