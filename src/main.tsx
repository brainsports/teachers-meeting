import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Landing from './Landing';
import App from './App';
import { usePostHeightToParent } from './postHeight';
import './index.css';
import './Landing.css';

// iframe(kpang.kr) 안에서 실행될 때 현재 문서 높이를 부모에게 전달
function HeightReporter() {
  usePostHeightToParent();
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <HeightReporter />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
