import pytensor
import pytensor.tensor as pt
import numpy as np

x = pt.scalar('x')
logp = pt.gammaln(0.0 + x) - pt.gammaln(x)
grad = pt.grad(logp, x)

f = pytensor.function([x], [logp, grad])

print("x=1e-12:", f(1e-12))
print("x=1e-8:", f(1e-8))
print("x=0.5:", f(0.5))
