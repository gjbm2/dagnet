# DagNet TODO

## In Progress

### High Priority
4. Amplitude, Google sheets pull through params
5. Context support
6. Scenario viewer (snapshotting)
7. Latency/lag management

### Medium Priority
- GIT_BATCH_OPERATIONS_MD
- Turn 'Path analysis' into a proper rc floating dock at the bottom left, but movebale (and re-dockable)
- Allow snapshotted 'delta analysis' views within what if panel; show colour-coded overlayed edges
- **Drag & Drop from Navigator to Graph** - See [DRAG_DROP_PROPOSAL.md](./DRAG_DROP_PROPOSAL.md) for full spec
  - Drag nodes/cases/parameters from navigator and drop on canvas to create/connect
  - Estimated: 36-48 hours full implementation, 28-38 hours MVP
- Nodal levels in the editor (some nodes are 'tall') & Sankey L-R mode with dyanmic node sizes
- auto-re-route doesn't start automatically (needs kicking)

### Low Priority
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding



---



Now we need to get data connections working.

The connect/selector class has a lightning symbol which opens a contextual menu that allows user to:
- pull data FROM the param into the graph
- push data FROM the graph into the param file
- pull latest data VIA the param file INTO The graph (and by implication, updating the param file)

We will also add a top menu 'Data'

under which we will have 
- Update all from params
- Update all params from graph
- Get latest live data for all params

When it comes to implementation, we want one code path for each method; and one which calls that for all params

Now let's sketch out the operation of each of these methods.

A. Update from files: will traverse the file in question and extract the key relevant values from it into the graph

B. Update from graph: vice versa 

C. Will go to param files, and see if there is a data source specified; if so use the relevant data source handler to retrieve the latest values from that source, bring them into the param file (opening it as needed), and then into the graph

To build this we will need:
I. a mapping between graph fields and relevant param fields. What is the best way of maintaining this alongside the various graph & param schemas?
II. a connection service for each of the third party data sources which draws from credentials, connects, retrieves, and then closes the connection
III. ideally it would do this on a batch basis if user retrieved 'All' (i.e. collect a list of all by data source, retrieve, update, return, then next data source, etc.)

for I. we want the same mapping to apply when connect-selector is used in node props and edge props (i.e. draw through the relevant data into any unpopulated fields on the graph when we first connect a node or edge).

for II. the two I would like to prototype with are Google Sheets and Ampltiude. For Sheets, I have a general idea that we need a Google Service account for this and the connection credentials for this. Beyond that I haven't looked deeper, so you need to research how to do that. For Amplitude, I know precisely what I want: A detailed discussion is in /AMPLITUDE_INTEGRATION.MD. The initial release of it though can be simpler: a pull from amplitude based on events defined between node pairs (markov chain order 0). THEN we'll get cleverer later. We'll need to add to the graph schema AND node schema to include event_id. We'll also probably need to add a NEW CLASS OF FILE TO THE SYSTEM GLOBALLY, "Events" which is a way we can tie together event references between (a) nodes (b) amplitude (c) the system -- _unless_ we think on reflection we can get away with just an event_id on node...let's think this through pros & cons. The point is that 'events' are canonical & immutable and just the SORT of thing that perhaps ought to live in a registry....?

---

Prepare a preliminary spec document for the above so we can develop a full proposal.

===



---


Cost params should be rolled-up by default unless they are set


Across the board, let's try making the labels (above fields) smaller than the fields they label -- e.g. restyle labels so they're systematically less prominent & smaller 

text size also too large

(node props is much better -- take that as style template)

In edge props:

Remove 'Probability parameter' label, 'Cost (£)' label and 'Cost time' label plus 'Probability' label (they are all in the sub-header, which should in each case use the appropriate 'paramter' icon not a cube

Move 'Std dev', 'Distribution' LEFT of their respective fields -- don't need full width for those fields.

Similarly at the top, 'Weight default' can be left of field.

Lose the explanation for 'Weight default' & move it into a tooltip

In node props:

- "Status" can be left of the drop down (and label 'Status' is too large)


-----



Basic properties panel on node props must expand dynamically if description field does

Conditional Probabilties are going to have to become subpanels with a 'Conditioanl probabilties' panel on edge props. Otherwise we're breaking the style norms with an orphaned heading and action button

Move the lightbulb tip into a tooltip and out of the panel itself

'Needs balancing' indicator on Probability slider on edge props > Parameters > Probabilties isn't working

On edge propts: You HAVE sub-type icons for proability, cost and time in side nav. use them! 




the creation logic flow for new conditional ps isn't quite right

if I create a new conditional p, we should:
- identify all siblings of this edge
- add the SAME conditional p with the SAME logic conditions to the other siblings
- apply the SAME colour (this is one group)
- allow user to balance weights ACROSS that group

this means some thoughtfulness about atomicity however as when I first create the conditional p I haven't yet defined the condition. e.g. user flow is:

1. click '+ Conditional probability' 
2. select which nodes will be required to trigger this
3. choose a colour (if they don't like the default one)

we should update the implied conditional p group (and therefore persist matching conditional p records on other sibling nodes, with complementary probabilities) when possible -- which in practice is only after step 2 (otherwise the group doesn't really have a unique identifiable context yet)

thereafter we should reflect colour change across the group, etc.

...and slides should balance across the implied group

Consider how to implement this smartly.
