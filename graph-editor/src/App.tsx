import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import GraphEditorPage from './pages/GraphEditorPage';
import ParamsPage from './pages/ParamsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<GraphEditorPage />} />
      <Route path="/params" element={<ParamsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
