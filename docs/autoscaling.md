# Autoscaling policy

The API deployment scales from 2 to 10 replicas using CPU and memory pressure.
It can double capacity at most once per minute, while scale-down waits five
minutes and removes no more than 25 percent per minute. This limits load bursts
against MongoDB, Redis, and Stellar dependencies.

Workers scale from 2 to 8 replicas using the external
`queue_age_seconds{queue="payment-processing"}` metric. A queue age above 30
seconds may add up to two workers per minute. Scale-down waits ten minutes and
removes one worker per two minutes, which gives in-flight jobs time to finish.

The worker HPA requires a metrics adapter and a Deployment named `worker` that
uses the queue's durable acknowledgement and idempotency controls. The API HPA
is independent, so API traffic cannot directly create duplicate worker jobs.
Before enabling the worker HPA, load tests must verify queue age, graceful
termination, and duplicate-job counters while scaling between the configured
limits.