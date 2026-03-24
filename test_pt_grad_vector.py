import pytensor
import pytensor.tensor as pt
import numpy as np

alpha = pt.vector('alpha')
counts = pt.constant(np.array([0.0, 2.0, 0.0]))
logp = pt.sum(pt.gammaln(counts + alpha) - pt.gammaln(alpha))
grad = pt.grad(logp, alpha)

f = pytensor.function([alpha], grad)

print("grad:", f(np.array([1.0, 1.0, 1.0])))
