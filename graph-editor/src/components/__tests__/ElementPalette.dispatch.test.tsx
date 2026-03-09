/**
 * ElementPalette event dispatch tests.
 *
 * Verifies that clicking creation elements dispatches the correct events
 * so that GraphCanvas handlers can capture selection state (DSL, etc.)
 * before entering draw mode.
 *
 * This test catches the bug where ElementPalette called setActiveElementTool
 * directly without dispatching dagnet:addAnalysis, causing the selection DSL
 * to never be captured into pendingAnalysisPayload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';

const mockSetActiveElementTool = vi.fn();

vi.mock('../../contexts/ElementToolContext', () => ({
  useElementTool: () => ({
    activeElementTool: 'select',
    setActiveElementTool: mockSetActiveElementTool,
  }),
}));

import { ElementPalette } from '../ElementPalette';

describe('ElementPalette event dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should dispatch dagnet:addAnalysis when Canvas Analysis button is clicked', () => {
    const dispatchSpy = vi.fn();
    window.addEventListener('dagnet:addAnalysis', dispatchSpy);

    const { getByTitle } = render(<ElementPalette layout="horizontal" />);
    const analysisButton = getByTitle(/Canvas Analysis/i);
    fireEvent.click(analysisButton);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener('dagnet:addAnalysis', dispatchSpy);
  });

  it('should call setActiveElementTool with new-node when Conversion Node button is clicked', () => {
    const { getByTitle } = render(<ElementPalette layout="horizontal" />);
    const nodeButton = getByTitle(/Conversion Node/i);
    fireEvent.click(nodeButton);

    expect(mockSetActiveElementTool).toHaveBeenCalledWith('new-node');
  });

  it('should call setActiveElementTool with new-postit when Post-It Note button is clicked', () => {
    const { getByTitle } = render(<ElementPalette layout="horizontal" />);
    const postitButton = getByTitle(/Post-It Note/i);
    fireEvent.click(postitButton);

    expect(mockSetActiveElementTool).toHaveBeenCalledWith('new-postit');
  });

  it('should call setActiveElementTool with new-container when Container button is clicked', () => {
    const { getByTitle } = render(<ElementPalette layout="horizontal" />);
    const containerButton = getByTitle(/Container/i);
    fireEvent.click(containerButton);

    expect(mockSetActiveElementTool).toHaveBeenCalledWith('new-container');
  });
});
