import pytensor
import pytensor.tensor as pt
import numpy as np

alpha = pt.scalar('alpha')
logp = pt.gammaln(0.0 + alpha) - pt.gammaln(alpha)
grad = pt.grad(logp, alpha)

f = pytensor.function([alpha], grad)

print("alpha=1.0:", f(1.0))
print("alpha=0.1:", f(0.1))
print("alpha=1e-5:", f(1e-5))
