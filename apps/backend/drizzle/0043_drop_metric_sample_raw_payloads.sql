UPDATE metric_samples
   SET raw_json = NULL
 WHERE raw_json IS NOT NULL;
