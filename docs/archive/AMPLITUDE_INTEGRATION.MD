Can we programmatically use the DAG to create an amplitude funnel if we specify the event IDs for each node?
You said:
Still a bit confused what is possible. 

I have, for an experiment, when it started, when it ended (eg not yet or whatever), I have all the nodes with events mapped to each. What I want to do is create an amplitude object and link to it which shows that specific funnel (as you say, a given sequence through the DAG).

Is this possible?
You said:
I still don't understand what is and isn't supported by their API.

My DAG is smarter about commercially meaningful event sequences than Amplitude. But I don't have aggregated event stream data in my DAG env nor do I want that (tons of data, complex to dedupe, query etc).

So I want to tell Amplitude the sequence of events I care about, but then use it to slice, dice, explore, etc.
You said:
ok. let me make sure I have got this.


I can pull from the Amplitude API a specific actual data set through "all of" or whatever an event series and get a json response, BUT I cannnot then use the ui to slice & dice that response, unless I manually re-create that same funnel report through the front end?
You said:
Would you like me to show you how to automatically generate a UI-ready funnel spec (step list, filters, etc.)

yes; how, if not through the api??
You said:
wait; I can COPY & PASTE JSON funnel definition into Amplitude UI? that would be fine

but are you SURE that there's a UI affordance for pasting in JSON blobs?
You said:
Ok.

So if we're in API world, which of the following is supported:

- Events in a sequence
- Any order / This order / Exact order
- OR combinations for funnel steps
- Segment by (need to ensure we exclude e.g. test user accounts)
- Date _and_ time window (e.g. since X, or between X and Y timestamp)

?
You said:
What does the return object look like?
You said:
ok. and if I want e.g. two segments: utm=abc and utm-def, is that 2x queries, or 1x with segments defined?
You said:
how many segments at once is the max?
You said:
right, but if I want e.g. 4x dims, then that's 2^4 segments, strictly speaking....?
You said:
ok. let's reason this through

I run an amplitude batch query set once per day (at 0100 or whatever)

first, I generate a set of unique journeys through my DAG which maximally covers all paths (down to some threashold de minimis condition)  [need an algo for this]

then, for all the segment products that I care about, I run Amplitude API for each of those paths against my defined event sequence

I retrieve and store as a 'daily param set' (I actually write this out to indiv. param files rather than storing the group, but that doesn't matter)

then I can reason across it and ask "what changed since yesterday" or whatever on my end?
You said:
Algo is a little more complicated than that.

At present, rather than include hyperpriors on every step, user defines conditoinal ps on my graph where they are actively interested in testing e.node-e-to-f.visited(node-c).p.mean

So when THOSE exist, I _do_ care about the markov (at least from c onwards, in the example given). When those DON'T exist, I could just get node-node pairings and that would suffice, right?

Again, want to build a smallest-reasonably-possible set of queries with maximal-possible-coverage accounting for hysteresis only where conditional probs/hyperpriors require it.
You said:
Go and reseach to double check everything you have asserted about how Amplitude API works and confirm that your guesses are correct.

ChatGPT can make mistakes. OpenAI doesn't use Nous Workspace workspace data to train its models.