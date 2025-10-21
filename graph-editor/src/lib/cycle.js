export function introducesCycle(nodes, edges) {
    const inDeg = new Map(nodes.map(n => [n, 0]));
    const adj = new Map(nodes.map(n => [n, []]));
    edges.forEach(e => { adj.get(e.from).push(e.to); inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1); });
    const q = nodes.filter(n => (inDeg.get(n) || 0) === 0);
    let seen = 0;
    while (q.length) {
        const n = q.shift();
        seen++;
        for (const m of adj.get(n)) {
            inDeg.set(m, inDeg.get(m) - 1);
            if ((inDeg.get(m) || 0) === 0)
                q.push(m);
        }
    }
    return seen !== nodes.length;
}
