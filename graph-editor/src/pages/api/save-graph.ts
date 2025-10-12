import { NextApiRequest, NextApiResponse } from 'next';

// In-memory storage for demo (in production, use a database)
const graphStorage: { [sessionId: string]: { graphData: any; timestamp: string } } = {};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { sessionId, graphData, timestamp } = req.body;

    if (!sessionId || !graphData) {
      return res.status(400).json({ error: 'Missing sessionId or graphData' });
    }

    // Store the graph data
    graphStorage[sessionId] = {
      graphData,
      timestamp
    };

    console.log(`Graph saved for session ${sessionId}`);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error saving graph:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
