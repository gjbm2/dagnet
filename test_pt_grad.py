import pytensor
import pytensor.tensor as pt
import numpy as np

mu = pt.scalar('mu')
sigma = pt.scalar('sigma')

# We want cdf differences to be very small, e.g. < 1e-12
ages = np.array([1.0, 1.000000000001, 1.000000000002, 4.0, 5.0, 6.0])
counts = np.array([0, 0, 2, 0, 0])
weights = np.array([1.0, 1.0, 1.0, 1.0, 1.0])
kappa = 10.0
p = 0.5

z = (pt.log(ages) - mu) / sigma
cdf = 0.5 * pt.erfc(-z)

cdf_coeffs = cdf[1:] - cdf[:-1]
cdf_coeffs = pt.clip(cdf_coeffs, 1e-12, 1.0)
alpha = kappa * p * cdf_coeffs
alpha = pt.maximum(alpha, 1e-12)

logp_terms = weights * (pt.gammaln(counts + alpha) - pt.gammaln(alpha))
logp = pt.sum(logp_terms)

grad = pt.grad(logp, [mu, sigma])
f = pytensor.function([mu, sigma], grad)

# With filter
ages_f = np.array([1.0, 1.000000000002, 4.0, 6.0])
counts_f = np.array([0, 2, 0])
weights_f = np.array([1.0, 1.0, 1.0])

z_f = (pt.log(ages_f) - mu) / sigma
cdf_f = 0.5 * pt.erfc(-z_f)

cdf_coeffs_f = cdf_f[1:] - cdf_f[:-1]
cdf_coeffs_f = pt.clip(cdf_coeffs_f, 1e-12, 1.0)
alpha_f = kappa * p * cdf_coeffs_f
alpha_f = pt.maximum(alpha_f, 1e-12)

logp_terms_f = weights_f * (pt.gammaln(counts_f + alpha_f) - pt.gammaln(alpha_f))
logp_f = pt.sum(logp_terms_f)

grad_f = pt.grad(logp_f, [mu, sigma])
f_f = pytensor.function([mu, sigma], grad_f)

g1 = f(2.0, 0.5)
g2 = f_f(2.0, 0.5)

print("Without filter:", g1)
print("With filter:   ", g2)
print("Diff mu:", g1[0] - g2[0])
print("Diff sigma:", g1[1] - g2[1])

