import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { AppShell } from './AppShell';
import Base64Encoder from './pages/Base64Encoder';

export default function App() {
  return (
    <Routes>
      <Route path="/base64" element={<Base64Encoder />} />
      <Route path="*" element={<AppShell />} />
    </Routes>
  );
}
