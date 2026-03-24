import scipy.special as sp

c2 = 5.0
a1 = 0.1
a2 = 0.2

logp_unmerged = (sp.gammaln(0 + a1) - sp.gammaln(a1)) + (sp.gammaln(c2 + a2) - sp.gammaln(a2))
logp_merged = sp.gammaln(c2 + a1 + a2) - sp.gammaln(a1 + a2)

print(f"Unmerged: {logp_unmerged}")
print(f"Merged:   {logp_merged}")
