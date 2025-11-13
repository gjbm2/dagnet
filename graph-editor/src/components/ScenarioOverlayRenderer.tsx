/**
 * ScenarioOverlayRenderer
 * 
 * Renders scenario overlays as additional edge layers with their own colors.
 * This component is placed in the GraphCanvas to render all visible scenarios.
 */

import React, { useMemo } from 'react';
import { useReactFlow } from 'reactflow';
import { useScenarioRendering } from '../hooks/useScenarioRendering';
import { Graph } from '../types';

interface ScenarioOverlayRendererProps {
  tabId?: string;
  graph: Graph | null;
}

/**
 * Renders scenario overlays for all visible scenarios
 * 
 * Each scenario is rendered as an SVG group containing paths for its edges.
 * The paths use the scenario's color and blend mode for visual comparison.
 */
export function ScenarioOverlayRenderer({ tabId, graph }: ScenarioOverlayRendererProps) {
  const { getEdges } = useReactFlow();
  const { hasVisibleScenarios, scenarioRenderData, isEnabled } = useScenarioRendering(tabId, graph);
  
  // Get current ReactFlow edges to match against
  const reactFlowEdges = getEdges();
  
  // Compute overlay paths for each visible scenario
  const overlayPaths = useMemo(() => {
    if (!hasVisibleScenarios || !isEnabled) {
      return null;
    }
    
    return scenarioRenderData.map((scenario) => {
      // For each scenario, render its edges as overlay paths
      const edgePaths = scenario.edges
        .map((edgeRenderData) => {
          // Find the corresponding ReactFlow edge to get its path
          const rfEdge = reactFlowEdges.find(
            e => e.id === edgeRenderData.edgeId || e.data?.uuid === edgeRenderData.edgeUuid
          );
          
          if (!rfEdge) {
            return null;
          }
          
          // Get the edge's DOM element to extract its path
          const edgeElement = document.querySelector(`[data-id="${rfEdge.id}"] path.react-flow__edge-path`);
          if (!edgeElement) {
            return null;
          }
          
          const pathData = edgeElement.getAttribute('d');
          if (!pathData) {
            return null;
          }
          
          return {
            id: edgeRenderData.edgeId,
            uuid: edgeRenderData.edgeUuid,
            path: pathData,
            width: edgeRenderData.width,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      
      return {
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        color: scenario.color,
        paths: edgePaths,
      };
    });
  }, [hasVisibleScenarios, isEnabled, scenarioRenderData, reactFlowEdges]);
  
  // Don't render anything if no visible scenarios
  if (!hasVisibleScenarios || !isEnabled || !overlayPaths) {
    return null;
  }
  
  return (
    <svg
      className="scenario-overlay-container"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 5, // Above edges but below selection UI
      }}
    >
      {overlayPaths.map((scenario) => (
        <g
          key={scenario.scenarioId}
          className="scenario-overlay"
          data-scenario-id={scenario.scenarioId}
          data-scenario-name={scenario.name}
        >
          {scenario.paths.map((pathData) => (
            <path
              key={`${scenario.scenarioId}-${pathData.uuid}`}
              d={pathData.path}
              style={{
                stroke: scenario.color,
                strokeWidth: pathData.width,
                strokeOpacity: 0.3, // Semi-transparent for overlay effect
                fill: 'none',
                strokeLinecap: 'butt',
                strokeLinejoin: 'miter',
                mixBlendMode: 'multiply', // Blend mode for color neutralization
              }}
              className="scenario-overlay-path"
            />
          ))}
        </g>
      ))}
    </svg>
  );
}

export default ScenarioOverlayRenderer;

