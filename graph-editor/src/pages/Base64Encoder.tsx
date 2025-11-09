import { useState } from 'react';
import { Box, Button, TextField, Typography, Paper, Alert } from '@mui/material';

export default function Base64Encoder() {
  const [base64Output, setBase64Output] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError('');
    setBase64Output('');

    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        // For text files, convert to base64
        const base64 = btoa(content);
        setBase64Output(base64);
      } catch (err) {
        setError(`Failed to encode file: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    reader.onerror = () => {
      setError('Failed to read file');
    };

    reader.readAsText(file);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(base64Output);
  };

  return (
    <Box sx={{ p: 4, maxWidth: 800, mx: 'auto' }}>
      <Typography variant="h4" gutterBottom>
        Base64 File Encoder
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Upload a text file (like a JSON service account key) to get its base64 encoding.
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Button
          variant="contained"
          component="label"
          fullWidth
          sx={{ mb: 2 }}
        >
          Select File
          <input
            type="file"
            hidden
            onChange={handleFileUpload}
            accept=".json,.txt,.yaml,.yml"
          />
        </Button>

        {fileName && (
          <Alert severity="info" sx={{ mb: 2 }}>
            File: {fileName}
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {base64Output && (
          <>
            <TextField
              label="Base64 Output"
              multiline
              rows={10}
              fullWidth
              value={base64Output}
              InputProps={{
                readOnly: true,
                sx: { fontFamily: 'monospace', fontSize: '0.85rem' }
              }}
              sx={{ mb: 2 }}
            />
            
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                onClick={handleCopy}
              >
                Copy to Clipboard
              </Button>
              
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                {base64Output.length} characters
              </Typography>
            </Box>
          </>
        )}
      </Paper>

      <Paper sx={{ p: 2, bgcolor: 'grey.50' }}>
        <Typography variant="subtitle2" gutterBottom>
          Usage:
        </Typography>
        <Typography variant="body2" component="div">
          1. Upload your service account JSON file<br />
          2. Copy the base64 output<br />
          3. Paste into credentials.yaml under <code>providers.google-sheets.service_account_json_b64</code>
        </Typography>
      </Paper>
    </Box>
  );
}

