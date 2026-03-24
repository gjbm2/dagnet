import pytensor
import pytensor.tensor as pt
import numpy as np

alpha = pt.scalar('alpha')
counts = pt.scalar('counts')

logp = pt.gammaln(counts + alpha) - pt.gammaln(alpha)
grad = pt.grad(logp, alpha)

f = pytensor.function([counts, alpha], grad)

print("counts=0, alpha=1e-2:", f(0.0, 1e-2))
print("counts=0, alpha=1e-8:", f(0.0, 1e-8))
print("counts=0, alpha=1e-12:", f(0.0, 1e-12))
