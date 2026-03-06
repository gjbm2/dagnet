/**
 * ScenarioLayerItem — normalised scenario entry for the shared ScenarioLayerList component.
 *
 * Both ScenariosPanel (sidebar, tab-sourced) and the chart properties section
 * (canvas analysis, recipe-sourced) provide data in this shape.
 */

export interface ScenarioLayerItem {
  id: string;
  name: string;
  colour: string;
  visible: boolean;
  visibilityMode: 'f+e' | 'f' | 'e';
  isLive?: boolean;
  tooltip?: string;
  /** 'current' | 'base' | 'user' — determines row styling and which affordances are available */
  kind: 'current' | 'base' | 'user';
}
